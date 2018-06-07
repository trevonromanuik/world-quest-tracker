const _ = require('lodash');
const async = require('async');
const dJSON = require('dirty-json');
const request = require('request');

const keys = require('./keys');

const ses = require('node-ses');
const client = ses.createClient({
    key: keys.aws.key,
    secret: keys.aws.secret,
    amazon: 'https://email.us-west-2.amazonaws.com'
});

const express = require('express');
const app = express();

const tracked_quests = {
    41896: 'Operation Murloc Freedom',
    42023: 'Black Rook Rumble',
    42025: 'Bareback Brawl',
    41013: 'Darkbrul Arena'
};
const tracked_quest_ids = _.keys(tracked_quests);

let quests = {};
let quest_ids = [];

app.post('/scheduled', (req, res) => {

    log(`scheduled task`);

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

            // parse out the WQ data
            const phrase = 'var lvWorldQuests = new Listview(';
            const start = body.indexOf(phrase) + phrase.length;
            if(start < phrase.length) return cb(`Could not find phrase in body: ${body}`);
            const end = body.indexOf(');', start);

            try {

                const data = dJSON.parse(body.substring(start, end)).data;
                const new_quests = _.keyBy(data, 'id');
                const new_quest_ids = _.keys(new_quests);
                const added_quest_ids = _.difference(new_quest_ids, quest_ids);

                if(added_quest_ids.length) {
                    log(`Added Quests: ${added_quest_ids.join(', ')}`);
                }

                quests = new_quests;
                quest_ids = new_quest_ids;

                const alert_quest_ids = _.intersection(added_quest_ids, tracked_quest_ids);
                if(!alert_quest_ids.length) return cb();

                log(`Alerting Quests: ${alert_quest_ids.join(', ')}`);

                const subject = `WQ Alert: ${_.chain(alert_quest_ids).map((id) => {
                    return `${tracked_quests[id]}`;
                }).join(', ').value()}`;

                const message = _.chain(alert_quest_ids).map((id) => {
                    return `${tracked_quests[id]}: ${new Date(quests[id].ending)}`;
                }).join('\n').value();

                sendEmail(subject, message, (err) => {
                    cb(err);
                });

            } catch(e) {
                return cb(e);
            }

        }
    ], (err) => {
        if (err) {
            sendEmail('WQ Tracker Error', JSON.stringify(err));
            log(`ERROR: ${JSON.stringify(err)}`);
        }
    });

    res.sendStatus(200);

});

app.listen(3000, () => {
    log('app listening on port 3000');
});

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

function log(message) {
    console.log(`${(new Date()).toISOString()} - ${message}`);
}