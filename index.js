"use strict";
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const path_fs = require("path");
const { Sequelize, DataTypes, Op } = require("sequelize");
const { Server } = require("socket.io");
const CronJob = require("cron").CronJob;
var color = require("cli-color");
const protocol = process.env.protocol || "http";
const host = process.env.host || "localhost";
const port = process.env.port || 8888;
const url_base = process.env.base_url || "/ytdiff";

const db_host = process.env.db_host || "localhost";
const save_loc = process.env.save_loc || "/home/sagnik/Videos/yt-dlp/";
const sleep_time = process.env.sleep ?? 3; // Will accept zero seconds, not recommended though.
const scheduled_update_string = process.env.scheduled || "0 */12 * * *"; // Default: Every 12 hours
const time_zone = process.env.time_zone || "Asia/Kolkata";

const get_subs = process.env.subtitles !== "false";
const get_description = process.env.description !== "false";
const get_comments = process.env.comments !== "false";
const get_thumbnail = process.env.thumbnail !== "false";

const MAX_LENGTH = 255; // this is what sequelize used for postgres
const not_needed = ["", "pornstar", "model", "videos"];
// spankbang lists playlits as playlist/1,2 so need to add a way to integarte it
const options = [
  "--embed-metadata",
  get_subs ? "--write-subs" : "",
  get_subs ? "--write-auto-subs" : "",
  get_description ? "--write-description" : "",
  get_comments ? "--write-comments" : "",
  get_thumbnail ? "--write-thumbnail" : "",
  "--paths",
].filter(Boolean);


// Logging methods
const info = (msg) => { console.log(color.blueBright(`[${new Date().toLocaleString()}] INFO: ${msg.trim()}\n`)); };
const verbose = (msg) => { console.log(color.greenBright(`[${new Date().toLocaleString()}] VERBOSE: ${msg.trim()}\n`)); };
const debug = (msg) => { console.log(color.magentaBright(`[${new Date().toLocaleString()}] DEBUG: ${msg.trim()}\n`)); };
const err = (msg) => { console.log(color.redBright(`[${new Date().toLocaleString()}] ERROR: ${msg.trim()}\n`)); };
const warn = (msg) => { console.log(color.yellowBright(`[${new Date().toLocaleString()}] WARN: ${msg.trim()}\n`)); };
const trace = (msg) => { console.log(color.cyanBright(`[${new Date().toLocaleString()}] TRACE: ${msg.trim()}\n`)); };

if (!fs.existsSync(save_loc)) {
  fs.mkdirSync(save_loc, { recursive: true });
}

const sequelize = new Sequelize("vidlist", "ytdiff", "ytd1ff", {
  host: db_host,
  dialect: "postgres",
  logging: false,
});

try {
  sequelize.authenticate().then(() => {
    info("Connection to database has been established successfully");
  });
} catch (error) {
  err(`Unable to connect to the database: ${error}`);
}

const video_list = sequelize.define("video_list", {
  url: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  id: {
    type: DataTypes.STRING,
    allowNull: false,
    primaryKey: true,
  },
  title: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  downloaded: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
  },
  available: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
  },
  /*
  The plan here is to make a way such that a video can have 
  multiple playlist_url and playlist_order for that given playlist_url
  */
  playlist_url: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  playlist_order: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  createdAt: {
    type: DataTypes.DATE,
    allowNull: false,
  },
  updatedAt: {
    type: DataTypes.DATE,
    allowNull: false,
  },
});

const playlist_list = sequelize.define("playlist_list", {
  title: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  url: {
    type: DataTypes.STRING,
    allowNull: false,
    primaryKey: true,
  },
  order_added: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
  monitoring_type: {
    type: DataTypes.SMALLINT,
    allowNull: false,
  },
  save_dir: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  createdAt: {
    type: DataTypes.DATE,
    allowNull: false,
  },
  updatedAt: {
    type: DataTypes.DATE,
    allowNull: false,
  },
});

sequelize
  .sync()
  .then(() => {
    info("video_list and playlist_list tables exist or are created successfully");
  })
  .catch((error) => {
    err(`Unable to create table : ${error}`);
  });

// sequelize need to start before this can start
const job = new CronJob(
  scheduled_update_string,
  scheduled_update_func,
  null,
  true,
  time_zone
);

// Utility functions
async function extract_json(req) {
  return new Promise((resolve, reject) => {
    var body = "";
    req.on("data", function (data) {
      body += data;
      if (body.length > 1e6) {
        req.connection.destroy();
        reject({ status: 413, message: "Request Too Large" });
      }
    });
    req.on("end", function () {
      try {
        const parsedBody = JSON.parse(body);
        resolve(parsedBody);
      } catch (error) {
        reject({ status: 400, message: "Invalid JSON" });
      }
    });
  });
}
async function string_slicer(str, len) {
  if (str.length > len) {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    return decoder.decode(encoder.encode(str.slice(0, len)));
  }
  return str;
}
async function url_to_title(body_url) {
  try {
    return new URL(body_url).pathname
      .split("/")
      .filter((item) => !not_needed.includes(item))
      .join("");
  } catch (error) {
    err(`${error.message}`);
    return body_url;
  }
}
async function list_spawner(body_url, start_num, stop_num) {
  trace(`list_spawner: Start: ${start_num}, Stop: ${stop_num}, Url: ${body_url}`);
  return new Promise((resolve, reject) => {
    const yt_list = spawn("yt-dlp", [
      "--playlist-start",
      start_num,
      "--playlist-end",
      stop_num,
      "--flat-playlist",
      "--print",
      "%(title)s\t%(id)s\t%(webpage_url)s",
      body_url,
    ]);
    var response = "";
    yt_list.stdout.on("data", (data) => {
      response += data;
    });
    yt_list.stderr.on("data", (data) => {
      // maybe use sockets to send the stderr to the
      err(`stderr: ${data}`);
    });
    yt_list.on("error", (error) => {
      err(`${error.message}`);
    });
    yt_list.on("close", (code) => {
      if (code !== 0) {
        err(`yt-dlp returned code: ${code}`);
      }
      resolve(response.split("\n").filter((line) => line.length > 0));
    });
  });
}
async function process_response(response, body_url, index) {
  // I forgot why but this index--; makes the whole thing work okey
  if (body_url !== "None") {
    index--;
  }
  trace(`process_response: Index: ${index}, Url: ${body_url}`);
  const init_resp = { count: 0, resp_url: body_url, start: index };
  sock.emit("listing-or-downloading", { percentage: 101 });
  await Promise.all(
    response.map(async (element) => {
      var title = element.split("\t")[0].trim(),
        item_available = true;
      const [vid_id, vid_url] = element.split("\t").slice(1);
      if (
        title === "[Deleted video]" ||
        title === "[Private video]" ||
        title === "[Unavailable video]"
      ) {
        item_available = false;
      } else if (title === "NA") {
        title = vid_id.trim();
      }
      const title_fixed = await string_slicer(title, MAX_LENGTH);
      try {
        // its pre-incrementing index here so in the listers it starts from 0
        const data = {
          id: vid_id,
          playlist_url: body_url,
          title: title_fixed,
          downloaded: false,
          available: item_available,
          playlist_order: ++index,
        };
        const [found, created] = await video_list.findOrCreate({
          where: { url: vid_url },
          defaults: data,
        });
        if (!created) {
          update_stuff(found, data);
        }
        init_resp["count"]++;
        //init_resp["rows"].push(found)
      } catch (error) {
        err(`${error.message}`);
      }
    })
  );
  return init_resp;
}
async function update_stuff(found, data) {
  // The object was found and not created
  // Doesn't change the downloaded state
  // I have a sneaking suspecion that this
  // will fail when there is any real change
  // in the video, lets see when that happens
  if (
    found.id !== data.id ||
    found.playlist_url !== data.playlist_url ||
    found.title !== data.title ||
    found.available !== data.available ||
    found.playlist_order !== data.playlist_order
  ) {
    const differences = [];
    if (found.id !== data.id) {
      differences.push(`id: ${found.id} (found) vs. ${data.id} (expected)`);
    }
    if (found.playlist_url !== data.playlist_url) {
      differences.push(`playlist_url: ${found.playlist_url} (found) vs. ${data.playlist_url} (expected)`);
    }
    if (found.title !== data.title) {
      differences.push(`title: ${found.title} (found) vs. ${data.title} (expected)`);
    }
    if (found.available !== data.available) {
      differences.push(`available: ${found.available} (found) vs. ${data.available} (expected)`);
    }
    if (found.playlist_order !== data.playlist_order) {
      differences.push(`playlist_order: ${found.playlist_order} (found) vs. ${data.playlist_order} (expected)`);
    }
    warn(`Found ${differences.length} difference(s): ${differences.join(', ')}`);
    found.id = data.id;
    found.playlist_url = data.playlist_url;
    found.title = data.title;
    found.available = data.available;
    found.playlist_order = data.playlist_order;
    await found.save();
  }
}
async function sleep(sleep_seconds = sleep_time) {
  return new Promise((resolve) => setTimeout(resolve, sleep_seconds * 1000));
}

// The scheduled updater
async function scheduled_update_func() {
  info(`Scheduled update started at: ${new Date().toLocaleString()}`);
  info(`Starting the quick update`);
  //quick update then full update
  quick_updates()
    .then(full_updates())
    .then(() =>
      sock.emit("playlist-done", {
        message: "done updating playlist or channel",
        id: "None",
      })
    );
  info(`Scheduled update finished at: ${new Date().toLocaleString()}`);
  info(`Next scheduled update on ${job.nextDates(1)}`);
}
//scheduled_update_func();

async function quick_updates() {
  const playlists = await playlist_list.findAndCountAll({
    where: {
      monitoring_type: 3,
    },
  });
  trace(`Updating ${playlists["rows"].length} playlists`)
  for (const playlist of playlists["rows"]) {
    var index = 0;
    const last_item = await video_list.findOne({
      where: {
        playlist_url: playlist.url,
      },
      order: [["playlist_order", "DESC"]],
      attributes: ["playlist_order"],
      limit: 1,
    });
    try {
      trace(`Playlist: ${playlist.title.trim()} being updated from index ${last_item.playlist_order}`)
      index = last_item.playlist_order;

      await sleep();
      await list_background(playlist.url, index, index + 10, 10);
      trace(`Done processing playlist ${playlist.url}`)

      playlist.changed("updatedAt", true);
      await playlist.save();
    } catch (error) {
      err(`error processing playlist ${playlist.url}, ${error.message}`)
    }
  }
}

async function full_updates() {
  const playlists = await playlist_list.findAndCountAll({
    where: {
      monitoring_type: 2,
    },
  });
  trace(`Updating ${playlists["rows"].length} playlists`);
  for (const playlist of playlists["rows"]) {
    try {
      trace(`Playlist: ${playlist.title.trim()} being updated fully`);

      await sleep();
      await list_background(playlist.url, 0, 10, 10);
      trace(`Done processing playlist ${playlist.url}`);

      playlist.changed("updatedAt", true);
      await playlist.save();
    } catch (error) {
      err(`error processing playlist ${playlist.url}\n${error.message}`);
    }
  }
}

// Download functions
async function download_lister(req, res) {
  try {
    const body = await extract_json(req),
      response_list = { item: [] };
    for (const id_str of body["id"]) {
      const entry = await video_list.findOne({ where: { id: id_str } });
      var save_dir_var = "";
      try {
        const play_list = await playlist_list.findOne({
          where: { url: entry.playlist_url },
        });
        save_dir_var = play_list.save_dir;
      } catch (error) {
        err(`${error.message}`);
        // do nothing, as this is just to make sure
        // that unlisted videos are put in save_loc
      }
      response_list["item"].push([
        entry.url,
        entry.title,
        save_dir_var,
        id_str,
      ]);
    }
    download_sequential(response_list["item"]);
    res.writeHead(200, corsHeaders(json_t));
    res.end(JSON.stringify(response_list));
  } catch (error) {
    err(`${error.message}`);
    const status = error.status || 500;
    res.writeHead(status, corsHeaders(json_t));
    res.end(JSON.stringify({ error: error.message }));
  }
}
// Add a parallel downloader someday
async function download_sequential(items) {
  trace(`Downloading ${items.length} videos sequentially`);
  var count = 1;
  for (const [url_str, title, save_dir, id_str] of items) {
    try {
      trace(`Downloading Video: ${count++}, Url: ${url_str}, Progress:`);
      var hold = null;
      // check if the trim is actually necessary
      const save_path = path_fs.join(save_loc, save_dir.trim());
      // if save_dir == "",  then save_path == save_loc
      if (save_path != save_loc && !fs.existsSync(save_path)) {
        fs.mkdirSync(save_path, { recursive: true });
      }
      sock.emit("download-start", { message: "" });
      const yt_dlp = spawn("yt-dlp", options.concat([save_path, url_str]));
      yt_dlp.stdout.on("data", async (data) => {
        try {
          // Keeping these just so it can be used to maybe add a progress bar
          const percentage = +/(\d{1,3}\.\d)/.exec(`${data}`)[0];
          if (percentage !== null) {
            if (Math.floor(percentage / 10) == 0 && hold === null) {
              hold = 0;
              trace(`${data}`);
            } else if (Math.floor(percentage / 10) > hold) {
              hold = Math.floor(percentage / 10);
              trace(`${data}`);
            }
            sock.emit("listing-or-downloading", { percentage: percentage });
          }
        } catch (error) {
          // this is done so that the toasts don't go crazy
          if (!error instanceof TypeError) {
            sock.emit("error", { message: `${error}` });
          }
        }
      });
      yt_dlp.stderr.on("data", (data) => {
        err(`stderr: ${data}`);
      });
      yt_dlp.on("error", (error) => {
        err(`${error.message}`);
      });
      yt_dlp.on("close", async (code) => {
        const entity = await video_list.findOne({ where: { url: url_str } });
        if (code === 0) {
          entity.set({
            downloaded: true,
          });
          await entity.save();
          sock.emit("download-done", {
            message: `${entity.title}`,
            id: id_str,
          });
        } else {
          sock.emit("download-failed", {
            message: `${entity.title}`,
            id: id_str,
          });
        }
      });
      // this holds the for loop, preventing the next iteration from happening
      await new Promise((resolve) => yt_dlp.on("close", resolve));
      trace(`Downloaded ${title} at location ${save_path}`);
    } catch (error) {
      err(`${error.message}`);
    }
  }
}

// List functions
async function list_and_download(req, res) {
  try {
    const body = await extract_json(req),
      start_num = body["start"] !== undefined ? +body["start"] : 1,
      stop_num = body["stop"] !== undefined ? +body["stop"] : 10,
      chunk_size = body["chunk"] !== undefined ? +body["chunk"] : 10,
      sleep_before_listing = body["continuous"] !== undefined ? body["continuous"] : false,
      monitoring_type = body["monitoring_type"] !== undefined ? body["monitoring_type"] : 1,
      download_list = body["download"] !== undefined ? body["download"] : null,
      dnld_list = { items: [] };
    var body_url = body["url"] !== undefined ? body["url"] : "",
      index = start_num > 0 ? start_num - 1 : 0; // index starts from 0 in this function
    debug(`body: ${JSON.stringify(body)}`);
    trace(`list_and_download:  body_url: ${body_url}, start_num: ${start_num}, ` +
      `stop_num: ${stop_num}, chunk_size: ${chunk_size}, download_list: [${download_list}], ` +
      `sleep_before_listing: ${sleep_before_listing}, index: ${index}, monitoring_type: ${monitoring_type}`);
    /*
    Checking if the body url is a playlist or not and checking if it's a single video and if it's available and or downloaded
      should be a good course fo action before continuing the rest of this process.
    */
    const is_playlist_indexed = playlist_list.findOne({ where: { url: body_url } });
    // will download all the indexes that are specified in the download_list
    if (is_playlist_indexed !== null && download_list !== null) {
      const videos = await video_list.findAll({ where: { playlist_url: body_url } });
      download_list.forEach(element => {
        dnld_list['items'].push([
          videos[element].url,
          videos[element].title,
          is_playlist_indexed.save_dir,
          videos[element].id,
        ]);
      });
      const status = 200;
      res.writeHead(status, corsHeaders(json_t));
      res.end(JSON.stringify({ "Downloading vidoes": JSON.stringify(dnld_list['items']) }));
      // this is where the download is triggered
      await download_sequential(dnld_list["item"]);
    }
    const entry = await video_list.findOne({ where: { url: body_url } });
    // will download the vidoe that is specified in the body_url
    if (entry !== null && download_list !== null) {
      dnld_list["item"].push([
        entry.url,
        entry.title,
        "",
        entry.id,
      ]);
      // downloading if it's already in the lists
      if (entry.downloaded) {
        try {
          res.writeHead(200, corsHeaders(json_t));
          res.end(
            JSON.stringify({
              message: "Already downloaded",
              entry: dnld_list["item"],
            })
          );
        } catch (error) {
          err(`${error.message}`);
        }
      } else if (!entry.downloaded) {
        try {
          res.writeHead(200, corsHeaders(json_t));
          res.end(
            JSON.stringify({
              message: "Downloading",
              entry: dnld_list["item"],
            })
          );
          // this is where the download is triggered
          await download_sequential(dnld_list["item"]);
        } catch (error) {
          err(`${error.message}`);
          // do nothing, as i don't really know what to do
        }
      }
    }
    // nither an indexed playlist nor an index video, will need to indexed and if necessary download
    // add the downloading thing later, too tired for now.
    else {
      /*This is to prevent spamming of the spawn process, since each spawn will only return first 10 items
        to the frontend but will continue in the background, this can cause issues like playlist_order getting 
        messed up or listing not completing.
        It"s best to not use bulk listing for playlists and channels but say you have 50 tabs open and you just 
        copy the urls then you can just set them to be processed in this mode.*/
      if (sleep_before_listing) await sleep();
      const response_list = await list_spawner(body_url, start_num, stop_num);
      verbose(`response_list:\t${JSON.stringify(
        response_list,
        null,
        2
      )}, response_list.length: ${response_list.length}`);
      if (response_list.length > 1 || body_url.includes("playlist")) {
        if (body_url.includes("youtube") && body_url.includes("/@")) {
          if (!/\/videos\/?$/.test(body_url)) {
            body_url = body_url.replace(/\/$/, "") + "/videos";
          }
          debug(`${body_url} is a youtube channel`);
        }
        if (body_url.includes("pornhub") && body_url.includes("/model/")) {
          if (!/\/videos\/?$/.test(body_url)) {
            body_url = body_url.replace(/\/$/, "") + "/videos";
          }
          debug(`${body_url} is a hub channel`);
        }
        const is_already_indexed = await playlist_list.findOne({
          where: { url: body_url },
        });
        try {
          is_already_indexed.title.trim();
        } catch (error) {
          err(
            "playlist or channel not encountered earlier, saving in playlist"
          );
          // Its not an error, but the title extraction,
          // will only be done once the error is raised
          await add_playlist(body_url, monitoring_type);
        }
      } else {
        body_url = "None";
        // If the url is determined to be an unlisted video
        // (i.e: not belonging to a playlist)
        // then the last unlisted video index is used to increment over.
        const last_item = await video_list.findOne({
          where: {
            playlist_url: body_url,
          },
          order: [["playlist_order", "DESC"]],
          attributes: ["playlist_order"],
          limit: 1,
        });
        try {
          index = last_item.playlist_order;
        } catch (error) {
          // encountered an error if unlisted videos was not initialized
          index = -1; // it will become 1 in the DB
        }
      }
      process_response(response_list, body_url, index)
        .then(function (init_resp) {
          try {
            res.writeHead(200, corsHeaders(json_t));
            res.end(JSON.stringify(init_resp));
          } catch (error) {
            err(`${error.message}`);
          }
        })
        .then(function () {
          list_background(body_url, start_num, stop_num, chunk_size).then(() => {
            trace(`Done processing playlist: ${body_url}`);
            sock.emit("playlist-done", {
              message: "done processing playlist or channel",
              id: body_url === "None" ? body["url"] : body_url,
            });
          });
        });


    }
  } catch (error) {
    err(`${error.message}`);
    const status = error.status || 500;
    res.writeHead(status, corsHeaders(json_t));
    res.end(JSON.stringify({ error: error.message }));
  }
}
async function monitoring_type_list(req, res) {
  try {
    const body = await extract_json(req),
      body_url = body["url"],
      monitoring_type = body["monitoring_type"];
    trace(`monitoring_type_list:  url: ${body_url}, monitoring_type: ${monitoring_type}`);
    const playlist = await playlist_list.findOne({ where: { url: body_url } });
    playlist.monitoring_type = monitoring_type;
    await playlist.update({ monitoring_type }, { silent: true });
    res.writeHead(200, corsHeaders(json_t));
    res.end(JSON.stringify({ Outcome: "Success" }));
  } catch (error) {
    error(`error in monitoring_type_list: ${error.message}`);
    const status = error.status || 500;
    res.writeHead(status, corsHeaders(json_t));
    res.end(JSON.stringify({ error: error.message }));
  }
}
async function list_background(body_url, start_num, stop_num, chunk_size) {
  while (true && body_url != "None") {
    start_num = start_num + chunk_size;
    stop_num = stop_num + chunk_size;
    // ideally we can set it to zero but that would get us rate limited by the services
    trace(`list_background: URL: ${body_url}, Chunk: ${chunk_size}, Start: ${start_num}, Stop: ${stop_num}`);
    await sleep();
    const response = await list_spawner(body_url, start_num, stop_num);
    if (response.length === 0) {
      break;
    }
    // yt-dlp starts counting from 1 for some reason so 1 needs to be subtrated here.
    await process_response(response, body_url, start_num - 1);
  }
}
async function add_playlist(url_var, monitoring_type_var) {
  var title_str = "",
    order_item = 0;
  const lastItem = await playlist_list.findOne({
    order: [["order_added", "DESC"]],
    attributes: ["order_added"],
    limit: 1,
  });
  if (lastItem !== null) order_item = lastItem.order_added + 1;
  const get_title = spawn("yt-dlp", [
    "--playlist-end",
    1,
    "--flat-playlist",
    "--print",
    "%(playlist_title)s",
    url_var,
  ]);
  get_title.stdout.on("data", async (data) => {
    title_str += data;
  });
  get_title.on("close", async (code) => {
    if (code === 0) {
      if (title_str == "NA\n") {
        try {
          title_str = await url_to_title(url_var);
        } catch (error) {
          title_str = url_var;
          err(`${error.message}`);
        }
      }
      title_str = await string_slicer(title_str, MAX_LENGTH);
      // no need to use found or create syntax here as this is only run the first time a playlist is made
      playlist_list.findOrCreate({
        where: { url: url_var },
        defaults: {
          title: title_str.trim(),
          monitoring_type: monitoring_type_var,
          save_dir: title_str.trim(),
          // this is coming as 0 everytime this needs fixing but I needs sleep
          order_added: order_item,
        },
      });
    } else {
      err("Playlist could not be created");
    }
  });
}

// List function that send data to frontend
async function playlists_to_table(req, res) {
  try {
    const body = await extract_json(req),
      start_num = body["start"] || 0,
      stop_num = body["stop"] || 10,
      sort_with = body["sort"] || 1,
      order = body["order"] || 1,
      query_string = body["query"] || "",
      type = order == 2 ? "DESC" : "ASC", // 0, 1 it will be ascending else descending
      row =
        sort_with == 2
          ? "createdAt"
          : sort_with == 3
            ? "updatedAt"
            : "order_added";
    trace(`playlists_to_table: Start: ${start_num}, Stop: ${stop_num}, Order: ${order}, Type: ${type}, Query: "${query_string}"`)
    if (query_string == "") {
      playlist_list
        .findAndCountAll({
          limit: stop_num - start_num,
          offset: start_num,
          order: [[row, type]],
        })
        .then((result) => {
          res.writeHead(200, corsHeaders(json_t));
          res.end(JSON.stringify(result, null, 2));
        });
    } else {
      playlist_list
        .findAndCountAll({
          where: {
            title: {
              [Op.iLike]: `%${query_string}%`,
            },
          },
          limit: stop_num - start_num,
          offset: start_num,
          order: [[row, type]],
        })
        .then((result) => {
          res.writeHead(200, corsHeaders(json_t));
          res.end(JSON.stringify(result, null, 2));
        });
    }
  } catch (error) {
    err(`${error.message}`);
    const status = error.status || 500;
    res.writeHead(status, corsHeaders(json_t));
    res.end(JSON.stringify({ error: error.message }));
  }
}
async function sublist_to_table(req, res) {
  try {
    const body = await extract_json(req),
      body_url = body["url"] || "None",
      start_num = +body["start"] || 0,
      stop_num = +body["stop"] || 10,
      query_string = body["query"] || "",
      sort_downloaded = body["sortDownloaded"],
      playlist_order = sort_downloaded ? "downloaded" : "playlist_order",
      playlist_order_type = sort_downloaded ? "DESC" : "ASC";
    trace(`sublist_to_table:  Start: ${start_num}, Stop: ${stop_num}, ` +
      `Order: ${playlist_order}, Type: ${playlist_order_type}, Query: "${query_string}", ` +
      `playlist_url: ${body_url}, sort_downloaded: ${sort_downloaded}`);
    // Sorting not implemented for sub-lists yet
    try {
      if (query_string == "") {
        video_list
          .findAndCountAll({
            where: {
              playlist_url: body_url,
            },
            limit: stop_num - start_num,
            offset: start_num,
            order: [[playlist_order, playlist_order_type]],
            // [["downloaded", "DESC"]] -- to show the download on top
            // [[playlist_order, playlist_order_type]] -- default
          })
          .then((result) => {
            res.writeHead(200, corsHeaders(json_t));
            res.end(JSON.stringify(result, null, 2));
          });
      } else {
        video_list
          .findAndCountAll({
            where: {
              playlist_url: body_url,
              title: {
                [Op.iLike]: `%${query_string}%`,
              },
            },
            limit: stop_num - start_num,
            offset: start_num,
            order: [[playlist_order, playlist_order_type]],
          })
          .then((result) => {
            res.writeHead(200, corsHeaders(json_t));
            res.end(JSON.stringify(result, null, 2));
          });
      }
    } catch (error) {
      err(`${error.message}`)
    }
  } catch (error) {
    err(`${error.message}`)
    const status = error.status || 500;
    res.writeHead(status, corsHeaders(json_t));
    res.end(JSON.stringify({ error: error.message }));
  }
}

const json_t = "text/json; charset=utf-8";
const html = "text/html; charset=utf-8";
const corsHeaders = (type) => {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": 2592000,
    "Content-Type": type,
  };
};

const types = {
  ".png": "image/png",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".ico": "image/x-icon",
  ".html": "text/html; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".xml": "application/xml",
};

function getFiles(dir) {
  const files = fs.readdirSync(dir);
  let fileList = [];

  files.forEach((file) => {
    const filePath = path_fs.join(dir, file);
    const extension = path_fs.extname(filePath);
    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      fileList = fileList.concat(getFiles(filePath));
    } else {
      fileList.push({ filePath, extension });
    }
  });

  return fileList;
}

function makeAssets(fileList) {
  const staticAssets = {};
  fileList.forEach((element) => {
    staticAssets[element.filePath.replace("dist", "/ytdiff")] = {
      file: fs.readFileSync(element.filePath),
      type: types[element.extension],
    };
  });
  staticAssets["/ytdiff/"] = staticAssets["/ytdiff/index.html"];
  staticAssets["/ytdiff"] = staticAssets["/ytdiff/index.html"];
  return staticAssets;
}

const filesList = getFiles("dist");
const staticAssets = makeAssets(filesList);

const server = http.createServer((req, res) => {
  if (req.url.startsWith(url_base) && req.method === "GET") {
    try {
      const get = req.url; //.replace(url_base, "");
      res.writeHead(200, corsHeaders(staticAssets[get].type));
      res.write(staticAssets[get].file);
    } catch (error) {
      res.writeHead(404, corsHeaders(html));
      res.write("Not Found");
    }
    res.end();
  } else if (req.method === "OPTIONS") {
    // necessary for cors
    res.writeHead(204, corsHeaders(json_t));
    res.end();
  } else if (req.method === "HEAD") {
    // necessary for health check
    res.writeHead(204, corsHeaders(json_t));
    res.end();
  } else if (req.url === url_base + "/list" && req.method === "POST") {
    list_and_download(req, res);
  } else if (req.url === url_base + "/download" && req.method === "POST") {
    download_lister(req, res);
  } else if (req.url === url_base + "/watchlist" && req.method === "POST") {
    monitoring_type_list(req, res);
  } else if (req.url === url_base + "/dbi" && req.method === "POST") {
    playlists_to_table(req, res);
  } else if (req.url === url_base + "/getsub" && req.method === "POST") {
    sublist_to_table(req, res);
  } else {
    res.writeHead(404, corsHeaders(html));
    res.write("Not Found");
    res.end();
  }
});

const io = new Server(server, {
  path: url_base + "/socket.io/",
  cors: {
    origin: [
      "https://lenovo-ideapad-320-15ikb.tail9ece4.ts.net",
      "http://localhost:5173",
      "http://192.168.0.103:5173",
      "http://192.168.0.106:5173",
      "http://localhost:8888",
      "http://192.168.0.103:8888",
      "http://192.168.0.106:8888",
    ],
  },
});

const clientConnected = ({ data, id }) => {
  info(`${data} to client id ${id}`)
};
const sock = io.on("connection", (socket) => {
  socket.emit("init", { message: "Connected", id: socket.id });
  socket.on("acknowledge", clientConnected);
  return socket;
});

server.listen(port, async () => {
  if (process.env.hide_ports === "true") {
    info(`Server listening on ${protocol}://${host}${url_base}`);
  } else {
    info(`Server listening on ${protocol}://${host}:${port}${url_base}`)
  }
  // I don't really know if calling these here is a good idea, but how else can I even do it?
  const start = Date.now();
  await sleep();
  const elapsed = Date.now() - start;
  info("Sleep duration: " + elapsed / 1000 + " seconds");
  info(`Next scheduled update is on ${job.nextDates(
    1
  )}`);
  verbose(`Download Options:\n\tyt-dlp ${options.join(
    " "
  )} "${save_loc.endsWith("/") ? save_loc : save_loc + "/"
    }{playlist_dir}" "{url}"`);
  verbose(`List Options:\n\t` +
    'yt-dlp --playlist-start {start_num} --playlist-end {stop_num} --flat-playlist --print "%(title)s\\t%(id)s\\t%(webpage_url)s" {body_url}')
  job.start();
});
