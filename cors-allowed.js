"use strict";
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const path_fs = require("path");
const { Sequelize, DataTypes, Op } = require("sequelize");
const { Server } = require("socket.io");
const CronJob = require("cron").CronJob;

const protocol = process.env.protocol || "http";
const host = process.env.host || "localhost";
const port = process.env.port || 8888;
const url_base = process.env.base_url || "/ytdiff";

const db_host = process.env.db_host || "localhost";
const save_loc = process.env.save_loc || "/home/sagnik/Videos/yt-dlp/";
const sleep_time = process.env.sleep ?? 3; // Will accept zero seconds, not recommended though.
const get_subs = process.env.subtitles || true;
const get_description = process.env.description || true;
const get_comments = process.env.comments || true;
const get_thumbnail = process.env.thumbnail || true;
const scheduled_update = process.env.scheduled || "0 */12 * * *"; // Default: Every 12 hours
const time_zone = process.env.time_zone || "Asia/Kolkata";

const MAX_LENGTH = 255; // this is what sequelize used for postgres
const not_needed = ["", "pornstar", "model", "videos"];
const options = [
    "--embed-metadata",
    get_subs ? "--write-subs" : "",
    get_subs ? "--write-auto-subs" : "",
    get_description ? "--write-description" : "",
    get_comments ? "--write-comments" : "",
    get_thumbnail ? "--write-thumbnail" : "",
    "--paths",
].filter(Boolean);

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
        console.log("Connection to database has been established successfully.");
    });
} catch (error) {
    console.error("Unable to connect to the database:", error);
}

const vid_list = sequelize.define("vid_list", {
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
    reference: {
        type: DataTypes.STRING,
        allowNull: false,
    },
    list_order: {
        type: DataTypes.INTEGER,
        allowNull: false,
    },
});

const play_lists = sequelize.define("play_lists", {
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
        //,autoIncrement: true,
        // why? because I want it to start from 0
        // whithout this defaultValue: 0,
    },
    watch: {
        type: DataTypes.SMALLINT,
        allowNull: false,
    },
    save_dir: {
        type: DataTypes.STRING,
        allowNull: false,
    }
});

sequelize.sync().then(() => {
    console.log("vid_list and play_lists tables exist or are created successfully!");
}).catch((error) => {
    console.error("Unable to create table : ", error);
});

// sequelize need to start before this can start
const job = new CronJob(scheduled_update, scheduledUpdate, null, true, time_zone);

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
        return (decoder.decode(encoder.encode(str.slice(0, len))));
    }
    return (str);
}
async function url_to_title(body_url) {
    try {
        return new URL(body_url).pathname.split("/").filter(item => !not_needed.includes(item)).join("");
    } catch (error) {
        console.error(error);
        return body_url
    }
}
async function list_spawner(body_url, start_num, stop_num) {
    console.log(`\nlist_spawner:\n\tStart: ${start_num}\n\tStop: ${stop_num}\n\tUrl: ${body_url}`);
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
            console.error(`stderr: ${data}`);
        });
        yt_list.on("error", (error) => {
            console.error(`error: ${error.message}`);
        });
        yt_list.on("close", (code) => {
            if (code !== 0) {
                console.error(`yt-dlp returned code: ${code}`);
            }
            resolve(response.split("\n").filter((line) => line.length > 0));
        });
    });
}
async function processResponse(response, body_url, index) {
    index--;
    console.log(`\nprocessResponse:\n\tIndex: ${index}\n\tUrl: ${body_url}`);
    const init_resp = { count: 0, resp_url: body_url, start: index };
    sock.emit("progress", { message: `Processing: ${body_url} from ${index}` });
    await Promise.all(response.map(async (element) => {
        var title = element.split("\t")[0].trim(),
            item_available = true;
        const [id, url] = element.split("\t").slice(1);
        if (title === "[Deleted video]" || title === "[Private video]" || title === "[Unavailable video]") {
            item_available = false;
        }
        else if (title === "NA") {
            title = id.trim();
        }
        const title_fixed = await string_slicer(title, MAX_LENGTH);
        try {
            // its pre-incrementing index here so in the listers it starts from 0
            const [found, created] = await vid_list.findOrCreate({
                where: { url: url },
                defaults: {
                    id: id,
                    reference: body_url,
                    title: title_fixed,
                    downloaded: false,
                    available: item_available,
                    list_order: ++index,
                },
            });
            if (!created) {
                // The object was found and not created
                // Doesn't change the downloaded state
                if (found.id !== id ||
                    found.reference !== body_url ||
                    found.title !== title_fixed ||
                    found.available !== item_available ||
                    found.list_order !== index - 1) {
                    // At least one property is different, update the object
                    found.id = id;
                    found.reference = body_url;
                    found.title = title_fixed;
                    found.available = item_available;
                    found.list_order = index - 1;
                }
                await found.save();
            }
            init_resp["count"]++;
            //init_resp["rows"].push(found)
        } catch (error) {
            console.error(error);
        }
    })
    );
    return init_resp;
}
async function sleep(sleep_seconds = sleep_time) {
    return new Promise((resolve) => setTimeout(resolve, sleep_seconds * 1000));
}

// The scheduled updater
async function scheduledUpdate() {
    console.log(`\nScheduled update started at: ${new Date().toISOString()}`);
    const playlists = await play_lists.findAndCountAll({
        where: {
            watch: true
        }
    });
    console.log(`\nUpdating ${playlists["rows"].length} playlists`);
    for (const playlist of playlists["rows"]) {
        var index = 0;
        const last_item = await vid_list.findOne({
            where: {
                reference: playlist.url,
            },
            order: [
                ["list_order", "DESC"],
            ],
            attributes: ["list_order"],
            limit: 1,
        });
        try {
            console.log(`\nPlaylist: ${playlist.title.trim()} being updated from index ${last_item.list_order}`);
            index = last_item.list_order;
        } catch (error) {
            // do nothing
        }
        await sleep();
        await list_background(playlist.url, index, index + 10, 10);
        console.log(`\nDone processing playlist ${playlist.url}`);
    }
    console.log(`\nScheduled update finished at: ${new Date().toISOString()}`);
    console.log(`\nNext scheduled update on ${job.nextDates(1)}`);
}

// Download functions
async function download_lister(req, res) {
    try {
        const body = await extract_json(req),
            response_list = { item: [] };
        for (const id_str of body["id"]) {
            const entry = await vid_list.findOne({ where: { id: id_str } });
            var save_dir_var = "";
            try {
                const play_list = await play_lists.findOne({ where: { url: entry.reference } });
                save_dir_var = play_list.save_dir;
            } catch (error) {
                //console.error(error);
                // do nothing, as this is just to make sure 
                // that unlisted videos are put in save_loc
            }
            response_list["item"].push([entry.url, entry.title, save_dir_var]);
        }
        download_sequential(response_list["item"]);
        res.writeHead(200, corsHeaders(json_t));
        res.end(JSON.stringify(response_list));
    } catch (error) {
        console.error(error);
        const status = error.status || 500;
        res.writeHead(status, corsHeaders(json_t));
        res.end(JSON.stringify({ "Error": error.message }));
    }
}
// Add a parallel downloader someday
async function download_sequential(items) {
    console.log(`\nDownloading ${items.length} videos sequentially`);
    for (const [url_str, title, save_dir] of items) {
        try {
            // check if the trim is actually necessary
            const save_path = path_fs.join(save_loc, save_dir.trim());
            // if save_dir == "",  then save_path == save_loc
            if (save_path != save_loc && !fs.existsSync(save_path)) {
                fs.mkdirSync(save_path, { recursive: true });
            }
            sock.emit("download-start", { message: title });
            const yt_dlp = spawn("yt-dlp", options.concat([save_path, url_str]));
            yt_dlp.stdout.on("data", async (data) => {
                sock.emit("progress", { message: "" });
                /*try {
                    // Keeping these just so it can be used to maybe add a progress bar
                    const percentage = /(\d{1,3}\.\d)%/.exec(`${data}`);
                    if (percentage !== null) {
                        sock.emit("progress", { message: percentage[0] });
                    }
                } catch (error) {
                    sock.emit("error", { message: `${error}` });
                }*/
            });
            yt_dlp.stderr.on("data", (data) => {
                console.error(`stderr: ${data}`);
            });
            yt_dlp.on("error", (error) => {
                console.error(`error: ${error.message}`);
            });
            yt_dlp.on("close", async (code) => {
                if (code === 0) {
                    const entity = await vid_list.findOne({ where: { url: url_str } });
                    entity.set({
                        downloaded: true,
                    });
                    await entity.save();
                    sock.emit("download-done", { message: `${entity.title}` });
                }
            });
            // this holds the for loop, preventing the next iteration from happening
            await new Promise((resolve) => yt_dlp.on("close", resolve));
            console.log(`\nDownloaded ${title} at location ${save_path}`)
        } catch (error) {
            console.error(error);
        }
    }
}

// List functions
async function list_init(req, res) {
    try {
        const body = await extract_json(req),
            start_num = +body["start"] || 1,
            stop_num = +body["stop"] || 10,
            chunk_size = +body["chunk"] || 10,
            continuous = body["continuous"] || false,
            watch = body["watch"] || 1;
        var body_url = body["url"],
            index = (start_num > 0) ? start_num - 1 : 0; // index starts from 0 in this function
        console.log(`\nlist_init:\n\tbody_url: ${body["url"]}\n\tstart_num: ${body["start"]}\n\t` +
            `stop_num: ${body["stop"]}\n\tchunk_size: ${body["chunk"]}\n\t` +
            `continuous: ${body["continuous"]}\n\tindex: ${index}\n\twatch: ${body["watch"]}`);
        /*This is to prevent spamming of the spawn process, since each spawn will only return first 10 items
        to the frontend but will continue in the background, this can cause issues like list_order getting 
        messed up or listing not completing.
        It"s best to not use bulk listing for playlists and channels but say you have 50 tabs open and you just 
        copy the urls then you can just set them to be processed in this mode.*/
        if (continuous) await sleep();
        const response_list = await list_spawner(body_url, start_num, stop_num);
        console.log(`\nresponse_list:\t${JSON.stringify(response_list, null, 2)}\n\tresponse_list.length: ${response_list.length}`);
        if (response_list.length > 1 || body_url.includes("playlist")) {
            if (body_url.includes("youtube") && body_url.includes("/@")) {
                if (!/\/videos\/?$/.test(body_url)) {
                    body_url = body_url.replace(/\/$/, "") + "/videos";
                }
                console.log(`\n${body_url} is a youtube channel`);
            }
            if (body_url.includes("pornhub") && body_url.includes("/model/")) {
                if (!/\/videos\/?$/.test(body_url)) {
                    body_url = body_url.replace(/\/$/, "") + "/videos";
                }
                console.log(`\n${body_url} is a hub channel`);
            }
            const is_already_indexed = await play_lists.findOne({
                where: { url: body_url },
            });
            try {
                is_already_indexed.title.trim();
            } catch (error) {
                console.error("playlist or channel not encountered earlier, saving in playlist");
                // Its not an error, but the title extraction, 
                // will only be done once the error is raised
                await add_playlist(body_url, watch);
            }
        } else {
            body_url = "None";
            // If the url is determined to be an unlisted video 
            // (i.e: not belonging to a playlist)
            // then the last unlisted video index is used to increment over.
            const last_item = await vid_list.findOne({
                where: {
                    reference: "None",
                },
                order: [
                    ["list_order", "DESC"],
                ],
                attributes: ["list_order"],
                limit: 1,
            });
            try {
                index = last_item.list_order;
            } catch (error) {
                // encountered an error if unlisted videos was not initialized
                index = 0; // it will become 1 in the DB
            }
        }
        processResponse(response_list, body_url, index)
            .then(function (init_resp) {
                try {
                    res.writeHead(200, corsHeaders(json_t));
                    res.end(JSON.stringify(init_resp));
                } catch (error) {
                    console.error(error);
                }
            }).then(function () {
                list_background(body_url, start_num, stop_num, chunk_size).then(
                    () => {
                        console.log(`\nDone processing playlist: ${body_url}`);
                        sock.emit("playlist-done", { message: "done processing playlist or channel" });
                    }
                );
            });
    } catch (error) {
        console.error(error);
        const status = error.status || 500;
        res.writeHead(status, corsHeaders(json_t));
        res.end(JSON.stringify({ "Error": error.message }));
    }
}
async function watch_list(req, res) {
    try {
        const body = await extract_json(req),
            body_url = body["url"],
            watch = body["watch"];
        console.log("In watch_list:", watch);
        const playlist = await play_lists.findOne({ where: { url: body_url } });
        playlist.watch = watch;
        await playlist.update({ watch }, { silent: true });
        res.writeHead(200, corsHeaders(json_t));
        res.end(JSON.stringify({ "Outcome": "Success" }));
    } catch (error) {
        console.error(error);
        const status = error.status || 500;
        res.writeHead(status, corsHeaders(json_t));
        res.end(JSON.stringify({ "Error": error.message }));
    }
}
async function list_background(body_url, start_num, stop_num, chunk_size) {
    while (true && (body_url != "None")) {
        start_num = start_num + chunk_size;
        stop_num = stop_num + chunk_size;
        // ideally we can set it to zero but that would get us rate limited by the services
        console.log(`\nlist_background:\n\tURL: ${body_url}\n\tChunk: ${chunk_size}\n\tStart: ${start_num}\n\tStop: ${stop_num}`);
        await sleep();
        const response = await list_spawner(body_url, start_num, stop_num);
        if (response.length === 0) {
            break;
        }
        // yt-dlp starts counting from 1 for some reason so 1 needs to be subtrated here.
        await processResponse(response, body_url, start_num - 1);
    }
}
async function add_playlist(url_var, watch_var) {
    var title_str = "";
    const lastItem = await play_lists.findOne({
        order: [["order_added", "DESC"]],
        attributes: ["order_added"],
        limit: 1,
    });
    const order_this = lastItem?.order_added ?? 0;
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
                    console.error(error);
                }
            }
            title_str = await string_slicer(title_str, MAX_LENGTH)
            // no need to use found or create syntax here as this is only run the first time a playlist is made
            play_lists.findOrCreate({
                where: { url: url_var },
                defaults: {
                    title: title_str,
                    watch: watch_var,
                    save_dir: title_str,
                    // this is coming as 0 everytime this needs fixing but I needs sleep
                    order_added: order_this === 0 ? 0 : order_this + 1
                },
            });
        } else {
            console.error("Playlist could not be created");
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
            type = (order == 2) ? "DESC" : "ASC", // 0, 1 it will be ascending else descending
            row = (sort_with == 2) ? "createdAt" : (sort_with == 3) ? "updatedAt" : "order_added";
        console.log(`\nplaylists_to_table:\n\tStart: ${start_num}\n\tStop: ${stop_num}\n\t` +
            `Order: ${order}\n\tType: ${type}\n\tQuery: "${query_string}"`);
        if (query_string == "") {
            play_lists.findAndCountAll({
                limit: stop_num - start_num,
                offset: start_num,
                order: [[row, type]],
            }).then((result) => {
                res.writeHead(200, corsHeaders(json_t));
                res.end(JSON.stringify(result, null, 2));
            });
        } else {
            play_lists.findAndCountAll({
                where: {
                    title: {
                        [Op.iLike]: `%${query_string}%`
                    }
                },
                limit: stop_num - start_num,
                offset: start_num,
                order: [[row, type]],
            }).then((result) => {
                res.writeHead(200, corsHeaders(json_t));
                res.end(JSON.stringify(result, null, 2));
            });
        }
    } catch (error) {
        console.error(error);
        const status = error.status || 500;
        res.writeHead(status, corsHeaders(json_t));
        res.end(JSON.stringify({ "Error": error.message }));
    }
}
async function sublist_to_table(req, res) {
    try {
        const body = await extract_json(req),
            body_url = body["url"] || "None",
            start_num = +body["start"] || 0,
            stop_num = +body["stop"] || 10,
            query_string = body["query"] || "",
            order = "list_order", type = "ASC";
        console.log(`\nsublist_to_table:\n\tStart: ${start_num}\n\tStop: ${stop_num}\n\t` +
            `Order: ${order}\n\tType: ${type}\n\tQuery: "${query_string}"\n\tReference: ${body_url}`);
        // Sorting not implemented for sub-lists yet
        try {
            if (query_string == "") {
                vid_list.findAndCountAll({
                    where: {
                        reference: body_url,
                    },
                    limit: stop_num - start_num,
                    offset: start_num,
                    order: [[order, type]],
                }).then((result) => {
                    res.writeHead(200, corsHeaders(json_t));
                    res.end(JSON.stringify(result, null, 2));
                });
            } else {
                vid_list.findAndCountAll({
                    where: {
                        reference: body_url,
                        title: {
                            [Op.iLike]: `%${query_string}%`
                        }
                    },
                    limit: stop_num - start_num,
                    offset: start_num,
                    order: [[order, type]],
                }).then((result) => {
                    res.writeHead(200, corsHeaders(json_t));
                    res.end(JSON.stringify(result, null, 2));
                });
            }
        } catch (error) {
            console.error(error);
        }
    } catch (error) {
        console.error(error);
        const status = error.status || 500;
        res.writeHead(status, corsHeaders(json_t));
        res.end(JSON.stringify({ "Error": error.message }));
    }
}

const css = "text/css; charset=utf-8";
const html = "text/html; charset=utf-8";
const js = "text/javascript; charset=utf-8";
const json_t = "text/json; charset=utf-8";
const corsHeaders = (type) => {
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": 2592000,
        "Content-Type": type
    }
};
const staticAssetsPaths = {
    "": { file: path_fs.join(__dirname, "/index.html"), type: html },
    "/": { file: path_fs.join(__dirname, "/index.html"), type: html },
    "/dbi": { file: path_fs.join(__dirname, "/dbi.html"), type: html },
    "/assets/bootstrap.min.css": { file: path_fs.join(__dirname, "/node_modules/bootstrap/dist/css/bootstrap.min.css"), type: css },
    "/assets/bootstrap.min.css.map": { file: path_fs.join(__dirname, "/node_modules/bootstrap/dist/css/bootstrap.min.css.map"), type: css },
    "/assets/bootstrap.bundle.min.js": { file: path_fs.join(__dirname, "/node_modules/bootstrap/dist/js/bootstrap.bundle.min.js"), type: js },
    "/assets/bootstrap.bundle.min.js.map": { file: path_fs.join(__dirname, "/node_modules/bootstrap/dist/js/bootstrap.bundle.min.js.map"), type: js },
    "/assets/favicon.ico": { file: path_fs.join(__dirname, "/favicon.ico"), type: "image/x-icon" },
    "/assets/socket.io.min.js": { file: path_fs.join(__dirname, "/node_modules/socket.io/client-dist/socket.io.min.js"), type: js },
    "/assets/socket.io.min.js.map": { file: path_fs.join(__dirname, "/node_modules/socket.io/client-dist/socket.io.min.js.map"), type: js },
    "/assets/nav.png": { file: path_fs.join(__dirname, "/nav.png"), type: "image/png" },
    "/assets/client.js": { file: path_fs.join(__dirname, "/client.js"), type: js }
};

const server = http.createServer((req, res) => {
    if (req.url.startsWith(url_base) && req.method === "GET") {
        try {
            const get = req.url.replace(url_base, "")
            res.writeHead(200, { "Content-Type": staticAssetsPaths[get].type });
            res.write(fs.readFileSync(staticAssetsPaths[get].file));
        } catch (error) {
            res.writeHead(404, { "Content-Type": html });
            res.write("Not Found");
        }
        res.end();
    } else if (req.method === "OPTIONS") {
        res.writeHead(204, corsHeaders(json_t));
        res.end();
    }
    else if (req.url === url_base + "/list" && req.method === "POST") {
        list_init(req, res);
    } else if (req.url === url_base + "/watchlist" && req.method === "POST") {
        watch_list(req, res);
    } else if (req.url === url_base + "/dbi" && req.method === "POST") {
        playlists_to_table(req, res);
    } else if (req.url === url_base + "/getsub" && req.method === "POST") {
        sublist_to_table(req, res);
    } else if (req.url === url_base + "/download" && req.method === "POST") {
        download_lister(req, res);
    } else {
        res.writeHead(404, { "Content-Type": html });
        res.write("Not Found");
        res.end();
    }
});

const io = new Server(server, { path: url_base + "/socket.io/" });
const sock = io.on("connection", (socket) => {
    socket.emit("init", { message: "Connected", id: socket.id });
    //socket.on("acknowledge", console.log);
    return socket;
});

server.listen(port, async () => {
    if (process.env.hide_ports || process.env.hide_ports == undefined)
        console.log(`Server listening on ${protocol}://${host}:${port}${url_base}`);
    else
        console.log(`Server listening on ${protocol}://${host}${url_base}`);
    // I don't really know if calling these here is a good idea, but how else can I even do it?
    await sleep();
    console.log(`Next scheduled update is on ${job.nextDates(1)}`);
    console.log(`Download Options:\nyt-dlp ${options.join(" ")} "${save_loc}/{playlist_dir}" "{url}"`);
    job.start();
});