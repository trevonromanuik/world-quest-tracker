const _ = require('lodash');
const async = require('async');
const dJSON = require('dirty-json');
const request = require('request');
const { Prisma } = require('prisma-binding');

const keys = require('./keys');

const LOG_LEVELS = {
  SEVERE: 1,
  ERROR: 2,
  WARNING: 3,
  INFO: 4,
  DEBUG: 5,
  VERBOSE: 6
};

const LOG_LEVEL_NAMES = _.keyBy(_.keys(LOG_LEVELS), (name) => {
  return LOG_LEVELS[name]
});

const log_level = LOG_LEVELS.DEBUG;

const TIMEZONE_OFFSET = 360;

const ses = require('node-ses');
const client = ses.createClient({
  key: keys.aws.key,
  secret: keys.aws.secret,
  amazon: 'https://email.us-west-2.amazonaws.com'
});

const express = require('express');
const app = express();

const tracked_quest_ids = [
  41896,//: 'Operation Murloc Freedom',
  42023,//: 'Black Rook Rumble',
  42025,//: 'Bareback Brawl',
  41013//: 'Darkbrul Arena'
];

const prisma = new Prisma({
  typeDefs: 'db/generated/prisma.graphql',
  endpoint: keys.prisma.url,
  secret: keys.prisma.secret,
  debug: false
});

const quest_fields = '{ _id name lastSeen type factions { _id } zones { _id } }';
const quest_instance_fields = '{ ending quest { _id } }';

(async () => {

  async function getMap(query, params, fields) {
    let items = await query(params, fields);
    return _.keyBy(items, item => item._id);
  }

  const items = await getMap(prisma.query.items);
  const quests = await getMap(prisma.query.quests, null, quest_fields);
  const factions = await getMap(prisma.query.factions);
  const zones = await getMap(prisma.query.zones);

  let quest_instances = await prisma.query.questInstances({
    where: { ending_gte: new Date() }
  }, quest_instance_fields);

  quest_instances = _.keyBy(quest_instances, (quest_instance) => {
    return quest_instance.quest._id;
  });

  app.post('/scheduled', (req, res) => {

    log(`scheduled task`, LOG_LEVELS.INFO);

    // first remove any expired quest instances from memory
    _.each(_.keys(quest_instances), (key) => {
      let quest_instance = quest_instances[key];
      if (!(quest_instance && new Date(quest_instance.ending) >= new Date())) {
        delete quest_instances[key];
      }
    });

    async.waterfall([
      (cb) => {

        // fetch the page from wowhead
        request('http://www.wowhead.com/world-quests/na', (err, response, body) => {
          if (err) return cb(err);
          if (response.statusCode !== 200) return cb(`Received invalid status code: ${response.statusCode}`);
          cb(null, body);
        });

      },
      (body, cb) => {

        (async () => {

          let start = 0;
          let zone_phrase = '<a href="http://www.wowhead.com/zone=';
          while ((start = body.indexOf(zone_phrase, start)) > -1) {

            start += zone_phrase.length;

            // first we need to parse out the id number
            let end = body.indexOf('/', start);
            let id = parseInt(body.substring(start, end));

            start = body.indexOf('>', end) + 1;
            end = body.indexOf('<', start);

            let name = body.substring(start, end);

            if (!zones[id]) {
              // we have not seen this Zone before - create it
              log(`Creating Zone: ${id} - ${name}`, LOG_LEVELS.DEBUG);
              zones[id] = await prisma.mutation.createZone({
                data: {
                  _id: id,
                  name: name
                }
              });
            }

          }

          start = 0;
          while ((start = body.indexOf('_[', start)) > -1) {

            start += 2;

            // first we need to parse out the id number
            let end = body.indexOf(']', start);
            let id = parseInt(body.substring(start, end));

            start = body.indexOf('{', end);
            end = body.indexOf('};', start) + 1;

            let data = dJSON.parse(body.substring(start, end));

            // now we need to figure out what kind of item this is
            if (_.has(data, 'jsonequip')) {
              // this is an Item
              if (!items[id]) {
                // we have not seen this Item before - create it
                log(`Creating Item: ${id} - ${data.name_enus}`, LOG_LEVELS.DEBUG);
                items[id] = await prisma.mutation.createItem({
                  data: {
                    _id: id,
                    name: data.name_enus,
                    quality: data.quality,
                    icon: data.icon
                  }
                });
              }
            } else if (_.has(data, 'reqclass') && _.has(data, 'reqrace')) {
              // this is a Quest
              if (!quests[id]) {
                // we have not seen this Quest before - create it
                log(`Creating Quest: ${id} - ${data.name_enus}`, LOG_LEVELS.DEBUG);
                quests[id] = await prisma.mutation.createQuest({
                  data: {
                    _id: id,
                    name: data.name_enus,
                    lastSeen: new Date(0),
                    type: -1,
                    factions: [],
                    zones: []
                  }
                }, quest_fields);
              }
            } else if (_.has(data, 'name_enus') && _.keys(data).length === 1) {
              // we're going to assume that this is a Faction
              if (!factions[id]) {
                // we have not seen this faction before - create it
                log(`Creating Faction: ${id} - ${data.name_enus}`, LOG_LEVELS.DEBUG);
                factions[id] = await prisma.mutation.createFaction({
                  data: {
                    _id: id,
                    name: data.name_enus
                  }
                });
              }
            }

          }

          // parse out the WQ data
          const phrase = 'var lvWorldQuests = new Listview(';
          start = body.indexOf(phrase) + phrase.length;
          if (start < phrase.length) return cb(`Could not find phrase in body: ${body}`);
          let end = body.indexOf(');', start);

          try {

            const new_quest_instance_ids = [];

            const data = dJSON.parse(body.substring(start, end)).data;
            async.eachLimit(data, 5, (item, cb) => {

              (async () => {

                try {

                  // check which Quest this is for
                  let quest = quests[item.id];
                  if (!quest) {
                    handleError(`Could not find Quest with id: ${item.id}`);
                    return cb();
                  }

                  // check if we already have an instance for this Quest
                  if (quest_instances[quest._id]) {
                    // we already have a running QuestInstance for this Quest - short out
                    return cb();
                  }

                  // else create a new QuestInstance
                  quest_instances[quest._id] = await prisma.mutation.createQuestInstance({
                    data: {
                      quest: { connect: { _id: quest._id } },
                      ending: new Date(item.ending),
                      rewards: []
                    }
                  }, quest_instance_fields);

                  // keep track that we made a new QuestInstance for this Quest
                  new_quest_instance_ids.push(quest._id);

                  // prep the Quest for updating
                  let where = { _id: quest._id };
                  let data = { lastSeen: new Date(item.ending) };

                  // check if the Quest still needs to be initialized
                  if (quest.type === -1) {
                    _.extend(data, {
                      type: item.worldquesttype,
                      factions: {
                        connect: _.chain(item.factions).map((id) => {
                          if (!factions[id]) {
                            handleError(`Could not find Faction with id: ${id}`);
                            return null;
                          }
                          return { _id: id };
                        }).compact().value()
                      },
                      zones: {
                        connect: _.chain(item.zones).map((id) => {
                          if (!zones[id]) {
                            handleError(`Could not find Zone with id: ${id}`);
                            return null;
                          }
                          return { _id: id };
                        }).compact().value()
                      }
                    });
                  }

                  quests[quest._id] = await prisma.mutation.updateQuest({
                    where,
                    data
                  }, quest_fields);

                } catch (e) {
                  handleError(e);
                  cb();
                }

              })();

            }, () => {

              const alert_quest_ids = _.intersection(new_quest_instance_ids, tracked_quest_ids);
              if (!alert_quest_ids.length) return cb();

              log(`Alerting Quests: ${alert_quest_ids.join(', ')}`, LOG_LEVELS.INFO);

              const subject = `WQ Alert: ${_.chain(alert_quest_ids).map((id) => {
                return `${quests[id].name}`;
              }).join(', ').value()}`;

              const message = _.chain(alert_quest_ids).map((id) => {
                return `${quests[id].name}: ${formatDate(quest_instances[id].ending)}`;
              }).join('\n').value();

              sendEmail(subject, message, (err) => {
                cb(err);
              });

            });

          } catch (e) {
            return cb(e);
          }

        })();

      }
    ], (err) => {
      if (err) {
        handleError(err);
      }
    });

    res.sendStatus(200);

    log(`completed scheduled task`, LOG_LEVELS.INFO);

  });

  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    log(`app listening on port ${port}`, LOG_LEVELS.INFO);
  });

  function formatDate(date) {

    date = new Date(date);
    date.setMinutes(date.getMinutes() - date.getTimezoneOffset() + TIMEZONE_OFFSET);

    let month = date.getMonth();
    let day = date.getDate();
    let year = date.getFullYear();
    let hour = date.getHours();
    let minute = date.getMinutes();

    if (minute < 10) minute = `0${minute}`;

    let period = hour >= 12 ? 'PM' : 'AM';
    if (hour > 12) hour -= 12;

    return `${month}/${day}/${year}, ${hour}:${minute} ${period}`;

  }

  function handleError(err) {
    if(err.stack) err = { message: err.message, stack: err.stack };
    sendEmail('WQ Tracker Error', JSON.stringify(err));
    log(`${JSON.stringify(err)}`, LOG_LEVELS.ERROR);
  }

  function sendEmail(subject, message, done) {
    client.sendEmail({
      to: keys.email,
      from: `WQ Tracker<${keys.email}>`,
      subject: subject,
      message: message
    }, function (err) {
      done && done(err);
    });
  }

  function log(message, level = LOG_LEVELS.ERROR) {
    if (level > log_level) return;
    console.log(`${(new Date()).toISOString()} [${LOG_LEVEL_NAMES[level]}] - ${message}`);
  }

})();