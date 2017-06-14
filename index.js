const express = require('express');
const freegeoip = require('node-freegeoip');
const sharp = require('sharp');
const morgan = require('morgan');
const multer = require('multer');
const Redis = require('ioredis');
const sha1 = require('sha1');
const upload = multer({ storage: multer.memoryStorage() });
const Discord = require('discord.js');

const hook = new Discord.WebhookClient(process.env.DISCORD_ID, process.env.DISCORD_TOKEN);

const SEVEN_DAYS = 7 * 24 * 60 * 60; // in seconds

//
// setup

const appURL = process.env.APP_URL;
const redis = new Redis(process.env.REDIS_URL);

//
// slack

//
// express

const app = express();
const port = process.env.PORT || 11000;

app.use(morgan('dev'));
app.listen(port, () => {
  console.log(`Express app running at http://localhost:${port}`);
});

//
// routes

app.post('/', upload.single('thumb'), async(req, res, next) => {
  const payload = JSON.parse(req.body.payload);
  const isVideo = (payload.Metadata.librarySectionType === 'movie' || payload.Metadata.librarySectionType === 'show');
  const isAudio = (payload.Metadata.librarySectionType === 'artist');
  const key = sha1(payload.Server.uuid + payload.Metadata.ratingKey);

  // missing required properties
  if (!payload.user || !payload.Metadata || !(isAudio || isVideo)) {
    return res.sendStatus(400);
  }

  console.log(payload.event);

  // retrieve cached image
  let image = await redis.getBuffer(key);

  // save new image
  if (payload.event === 'media.play' || payload.event === 'media.stop' || payload.event === 'media.pause' || payload.event === 'media.resume') {
    if (image) {
      console.log('[REDIS]', `Using cached image ${key}`);
    } else if (!image && req.file && req.file.buffer) {
      console.log('[REDIS]', `Saving new image ${key}`);
      image = await sharp(req.file.buffer)
        .resize(75, 75)
        .background('white')
        .embed()
        .toBuffer();

      redis.set(key, image, 'EX', SEVEN_DAYS);
    }
  }

  if (!isVideo) {
    return;
  }

  // post to slack
  const location = await getLocation(payload.Player.publicAddress);

  let action;
  let colour;

  if (payload.event === 'media.play') {
    action = 'started watching';
    colour = '#36a64f';
  } else if (payload.event === 'media.stop') {
    action = 'stopped watching';
    colour = 'danger';
  } else if (payload.event === 'media.resume') {
    action = 'resumed playback of';
    colour = '#36a64f';
  } else if (payload.event === 'media.pause') {
    action = 'paused playback of';
    colour = '#a67a2d';
  } else {
    return;
  }

  if (image) {
    console.log('[SLACK]', `Sending ${key} with image`);
    notifyDiscord(appURL + '/images/' + key, payload, location, action, colour);
  } else {
    console.log('[SLACK]', `Sending ${key} without image`);
    notifyDiscord(null, payload, location, action, colour);
  }

  res.sendStatus(200);

});

app.get('/images/:key.jpg', async(req, res, next) => {
  const exists = await redis.exists(req.params.key);

  if (!exists) {
    return next();
  }

  const image = await redis.getBuffer(req.params.key);
  res.contentType('jpeg')
  sharp(image).jpeg().pipe(res);
});

//
// error handlers

app.use((req, res, next) => {
  const err = new Error('Not Found');
  err.status = 404;
  next(err);
});

app.use((err, req, res, next) => {
  res.status(err.status || 500);
  res.send(err.message);
});

//
// helpers

function getLocation(ip) {
  return new Promise((resolve, reject) => {
    freegeoip.getLocation(ip, function (err, location) {
      if (err) {
        return reject(err);
      }
      return resolve(location);
    });
  });
}

function formatTitle(metadata) {
  if (metadata.grandparentTitle) {
    return metadata.grandparentTitle;
  } else {
    let ret = metadata.title;
    if (metadata.year) {
      ret += ` (${metadata.year})`;
    }
    return ret;
  }
}

function formatSubtitle(metadata) {
  let ret = '';

  if (metadata.grandparentTitle) {
    if (metadata.type === 'track') {
      ret = metadata.parentTitle;
    } else if (metadata.index && metadata.parentIndex) {
      ret = `S${metadata.parentIndex} E${metadata.index}`;
    } else if (metadata.originallyAvailableAt) {
      ret = metadata.originallyAvailableAt;
    }

    if (metadata.title) {
      ret += ' - ' + metadata.title;
    }
  } else if (metadata.type === 'movie') {
    ret = metadata.tagline;
  }

  return ret;
}

function notifyDiscord(imageUrl, payload, location, action, colour) {
  let locationText = '';

  if (location) {
    const state = location.country_code === 'US' ? location.region_name : location.country_name;
    locationText = `near ${location.city}, ${state}`;
  }
  console.log("Sending notification to Discord");
  console.log(imageUrl + '.jpg');

  hook.sendSlackMessage({
    'username': 'Plex',
    'text': `${payload.Account.title} ${action} ${formatTitle(payload.Metadata)} on ${payload.Server.title}`/*,
    'attachments': [{
      'color': colour,
      'title': formatTitle(payload.Metadata),
      'text': formatSubtitle(payload.Metadata),
      'thumb_url': imageUrl + '.jpg',
      'footer': payload.Metadata.summary,
    }]*/
  });
}

