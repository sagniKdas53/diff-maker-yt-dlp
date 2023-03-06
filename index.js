"use strict";
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const { Sequelize, DataTypes, Op } = require("sequelize");
const { Server } = require("socket.io");
const CronJob = require("cron").CronJob;

const protocol = process.env.protocol || "http";
const host = process.env.host || "localhost";
const port = process.env.port || 8888;
const url_base = process.env.base_url || "/ytdiff";

const db_host = process.env.db_host || "localhost";
const save_loc = process.env.save_loc || "yt-dlp-2";
const sleep_time = process.env.sleep ?? 3; // Will accept zero seconds, not recommended tho.
const get_subs = process.env.subtitles || true;
const get_description = process.env.description || true;
const get_comments = process.env.comments || true;
const get_thumbnail = process.env.thumbnail || true;
const scheduled_update = process.env.scheduled || "0 */12 * * *"; // Default: Every 12 hours
const time_zone = process.env.time_zone || "Asia/Kolkata";
// not sure if this will work
const make_sub_dirs = process.env.make_dirs || true;

const options = [
    "--embed-metadata",
    "--paths",
    `${save_loc}`,
    get_subs ? "--write-subs" : "",
    get_subs ? "--write-auto-subs" : "",
    get_description ? "--write-description" : "",
    get_comments ? "--write-comments" : "",
    get_thumbnail ? "--write-thumbnail" : ""
].filter(Boolean);
//console.log(options);

if (!fs.existsSync(save_loc)) {
    fs.mkdirSync(save_loc);
}

const sequelize = new Sequelize("vidlist", "ytdiff", "ytd1ff", {
    host: db_host,
    dialect: "postgres",
    logging: false,
});

try {
    sequelize.authenticate().then(() => {
        console.log("Connection has been established successfully.");
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
        autoIncrement: true,
    },
    watch: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
    }
});

sequelize.sync().then(() => {
    console.log("vid_list and play_lists tables exist or are created successfully!");
}).catch((error) => {
    console.error("Unable to create table : ", error);
});

// sequelize need to start befor this can start
new CronJob(scheduled_update, scheduledUpdate, null, true, time_zone).start();

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
function ytdlp_spawner(body_url, start_num, stop_num) {
    //console.log("In spawner", "Start:", start_num, "Stop:", stop_num);
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
            resolve(response.split("\n").filter((line) => line.length > 0));
        });
    });
}
async function processResponse(response, body_url, index) {
    const init_resp = { count: 0, rows: [] }
    //console.log("In processResponse", "Start:", index);
    sock.emit("progress", { message: `Processing: ${body_url} from ${index}` });
    await Promise.all(response.map(async (element) => {
        const [id, url] = element.split("\t").slice(1);
        var title = element.split("\t")[0];
        if (title === "[Deleted video]" || title === "[Private video]") {
            return;
        } else if (title === "NA") {
            title = id;
        }
        const item_available = title !== "[Unavailable video]";
        try {
            // its pre-incrementing index here so in the listers it starts from 0
            const [found, created] = await vid_list.findOrCreate({
                where: { url: url },
                defaults: {
                    id: id,
                    reference: body_url,
                    title: title,
                    downloaded: false,
                    available: item_available,
                    list_order: ++index,
                },
            });
            if (!created) {
                // The object was found and not created
                //console.log("Found object: ", found);
                if (found.id !== id ||
                    found.reference !== body_url ||
                    found.title !== title ||
                    found.available !== item_available ||
                    found.list_order !== index - 1) {
                    // At least one property is different, update the object
                    found.id = id;
                    found.reference = body_url;
                    found.title = title;
                    found.available = item_available;
                    found.list_order = index - 1;
                    //console.log("Found object updated: ", found);
                } else {
                    found.changed("updatedAt", true);
                }
                await found.save();
            }
            init_resp["count"]++;
            init_resp["rows"].push(found)
        } catch (error) {
            console.error(error);
        }
    })
    );
    return init_resp;
}
async function sleep() {
    return new Promise((resolve) => setTimeout(resolve, sleep_time * 1000));
}

// The scheduled updater
async function scheduledUpdate() {
    const start = new Date();
    console.log("Scheduled update started at:", start.toISOString());
    const playlists = await play_lists.findAndCountAll({
        where: {
            watch: true
        }
    });
    //console.log(playlists['rows']);
    for (const playlist of playlists['rows']) {
        //console.log("playlist:", playlist);
        var index = 0;
        const last_item = await vid_list.findOne({
            where: {
                reference: "None",
            },
            order: [
                ["createdAt", "DESC"],
            ],
            attributes: ["list_order"],
            limit: 1,
        });
        try {
            //console.log(last_item.list_order);
            index = last_item.list_order;
        } catch (error) {
            // do nothing
        }
        //console.log(playlist.url, index, index + 10, 10);
        await sleep();
        //console.log(new Date() - start);
        await list_background(playlist.url, index, index + 10, 10);
        //console.log(`Done processing playlist ${playlist.url}`);
        //console.log(new Date() - start);
    }
    console.log("Scheduled update finished at:", new Date().toISOString());
}

// Download funtions
async function download_lister(req, res) {
    try {
        const body = await extract_json(req),
            response_list = { item: [] };
        for (const id_str of body["id"]) {
            const entry = await vid_list.findOne({ where: { id: id_str } });
            response_list["item"].push([entry.url, entry.title]);
        }
        download_sequential(response_list["item"]);
        res.writeHead(200, { "Content-Type": json_t });
        res.end(JSON.stringify(response_list));
    } catch (error) {
        console.error(error);
        const status = error.status || 500;
        res.writeHead(status, { "Content-Type": json_t });
        res.end(JSON.stringify({ "Error": error.message }));
    }
}
// Add a parallel downloader someday
async function download_sequential(items) {
    //console.log(items);
    for (const [url_str, title] of items) {
        try {
            sock.emit("download-start", { message: title });
            const yt_dlp = spawn("yt-dlp", options.concat(url_str));
            yt_dlp.stdout.on("data", async (data) => {
                sock.emit("progress", { message: "" });
                /*try {
                    // Keeing these just so it can be used to maybe add a progress bar
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
                if (code == 0) {
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
        } catch (error) {
            console.error(error);
        }
    }
}

// List funtions
async function list_init(req, res) {
    try {
        const body = await extract_json(req),
            start_num = +body["start"] || 1,
            stop_num = +body["stop"] || 10,
            chunk_size = +body["chunk"] || 10,
            continuous = body["continuous"] || false,
            watch = body["watch"] || false;
        //console.log("watch: " + watch);
        /*This is to prevent spamming of the spawn process, since each spawn will only return first 10 items
        to the frontend but will continue in the background, this can cause issues like list_order getting 
        messed uo or listing not completing.
        It's best to not use bulk listing for playlists, channels but say you have 50 tabs open and you just 
        copy the urls then you can just set them to be processed in this mode.*/
        if (continuous) await sleep();
        var body_url = body["url"],
            index = start_num - 1; // index starts from 0 in this function
        //console.log("body_url: " + body["url"],"\nstart_num: " + body["start"],"\nstop_num:", 
        //    body["stop"],"\nchunk_size:", body["chunk"],"\ncontinuous:", body["continuous"]);
        const response_list = await ytdlp_spawner(body_url, start_num, stop_num);
        //console.log("response_list: "+response_list+"\nresponse_list.length: "+response_list.length);
        if (response_list.length > 1 || body_url.includes("playlist")) {
            var title_str = "";
            if (body_url.includes("youtube") && body_url.includes("/@")) {
                if (!/\/videos\/?$/.test(body_url)) {
                    body_url = body_url.replace(/\/$/, "") + "/videos";
                }
                //console.log(`${body_url} is a youtube channel`);
            }
            if (body_url.includes("pornhub") && body_url.includes("/model/")) {
                if (!/\/videos\/?$/.test(body_url)) {
                    body_url = body_url.replace(/\/$/, "") + "/videos";
                }
                //console.log("Pornhub channel url: " + body_url);
            }
            const is_alredy_indexed = await play_lists.findOne({
                where: { url: body_url },
            });
            try {
                is_alredy_indexed.changed("updatedAt", true);
                await is_alredy_indexed.save();
                title_str = is_alredy_indexed.title;
            } catch (error) {
                //console.error("playlist or channel not encountered earlier");
                // Its not an error, but the title extartion 
                // will only be done once the error is raised
                if (title_str == "") {
                    const get_title = spawn("yt-dlp", [
                        "--playlist-end",
                        1,
                        "--flat-playlist",
                        "--print",
                        "%(playlist_title)s",
                        body_url,
                    ]);
                    get_title.stdout.on("data", async (data) => {
                        title_str += data;
                    });
                    get_title.on("close", (code) => {
                        if (title_str == "NA\n") {
                            title_str = body_url;
                        }
                        // no need to use found or create syntax here as this is only run the first time
                        play_lists.findOrCreate({
                            where: { url: body_url },
                            defaults: {
                                title: title_str.trim(),
                                watch: watch
                            },
                        });
                    });
                }
            }
        } else {
            body_url = "None";
            // If the url is determined to be an unlisted (not belnging to a playlist) vidoe,
            // then the last unlisted vidoe index is used to icrement over.
            const last_item = await vid_list.findOne({
                where: {
                    reference: "None",
                },
                order: [
                    ["createdAt", "DESC"],
                ],
                attributes: ["list_order"],
                limit: 1,
            });
            try {
                //console.log(last_item.list_order);
                index = last_item.list_order;
            } catch (error) {
                // encountered an error if unlisted vidoes was not initialized
                index = 0; // it will become 1 in the DB
            }
        }
        processResponse(response_list, body_url, index)
            .then(function (init_resp) {
                try {
                    res.writeHead(200, { "Content-Type": json_t });
                    res.end(JSON.stringify(init_resp));
                } catch (error) {
                    console.error(error);
                }
            }).then(function () {
                list_background(body_url, start_num, stop_num, chunk_size).then(
                    () => {
                        //console.log("done processing playlist");
                        sock.emit("playlist-done", { message: "done processing playlist or channel" });
                    }
                );
            });
    } catch (error) {
        console.error(error);
        const status = error.status || 500;
        res.writeHead(status, { "Content-Type": json_t });
        res.end(JSON.stringify({ "Error": error.message }));
    }
}
async function watch_list(req, res) {
    try {
        const body = await extract_json(req),
            body_url = body["url"],
            watch = body["watch"];
        const playlist = await play_lists.findOne({ where: { url: body_url } });
        playlist.watch = watch;
        await playlist.update({ watch }, { silent: true });
        res.writeHead(200, { "Content-Type": json_t });
        res.end(JSON.stringify({ "Outcome": "Success" }));
    } catch (error) {
        console.error(error);
        const status = error.status || 500;
        res.writeHead(status, { "Content-Type": json_t });
        res.end(JSON.stringify({ "Error": error.message }));
    }
}
async function list_background(body_url, start_num, stop_num, chunk_size) {
    //console.log("In list_background", "body_url", body_url, "start_num", start_num, "stop_num", stop_num, "chunk_size", chunk_size);
    while (true && (body_url != "None")) {
        start_num = start_num + chunk_size;
        stop_num = stop_num + chunk_size;
        // ideally we can set it to zero but that would get us rate limited by the services
        await sleep();
        //console.log("In background lister", "Chunk:", chunk_size, "Start:", start_num, "Stop:", stop_num);
        const response = await ytdlp_spawner(body_url, start_num, stop_num);
        if (response.length === 0) {
            break;
        }
        await processResponse(response, body_url, start_num);
    }
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
        //console.log("Start: ", start_num, " Stop: ", stop_num, " Order: ", order, " Type: ", type, " Query: ", query_string);
        if (query_string == "") {
            play_lists.findAndCountAll({
                limit: stop_num - start_num,
                offset: start_num,
                order: [[row, type]],
            }).then((result) => {
                res.writeHead(200, { "Content-Type": json_t });
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
                res.writeHead(200, { "Content-Type": json_t });
                res.end(JSON.stringify(result, null, 2));
            });
        }
    } catch (error) {
        console.error(error);
        const status = error.status || 500;
        res.writeHead(status, { "Content-Type": json_t });
        res.end(JSON.stringify({ "Error": error.message }));
    }
}
async function sublist_to_table(req, res) {
    try {
        const body = await extract_json(req),
            body_url = body["url"],
            start_num = +body["start"] || 0,
            stop_num = +body["stop"] || 10,
            query_string = body["query"] || "",
            order = "list_order", type = "ASC";
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
                    res.writeHead(200, { "Content-Type": json_t });
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
                    res.writeHead(200, { "Content-Type": json_t });
                    res.end(JSON.stringify(result, null, 2));
                });
            }
        } catch (error) {
            console.error(error);
        }
    } catch (error) {
        console.error(error);
        const status = error.status || 500;
        res.writeHead(status, { "Content-Type": json_t });
        res.end(JSON.stringify({ "Error": error.message }));
    }
}

const css = "text/css; charset=utf-8";
const html = "text/html; charset=utf-8";
const js = "text/javascript; charset=utf-8";
const json_t = "text/json; charset=utf-8";
const staticAssets = {
    "": { obj: fs.readFileSync(__dirname + "/index.html"), type: html },
    "/": { obj: fs.readFileSync(__dirname + "/index.html"), type: html },
    "/dbi": { obj: fs.readFileSync(__dirname + "/dbi.html"), type: html },
    "/assets/bootstrap.min.css": { obj: fs.readFileSync(__dirname + "/node_modules/bootstrap/dist/css/bootstrap.min.css"), type: css },
    "/assets/bootstrap.min.css.map": { obj: fs.readFileSync(__dirname + "/node_modules/bootstrap/dist/css/bootstrap.min.css.map"), type: css },
    "/assets/bootstrap.bundle.min.js": { obj: fs.readFileSync(__dirname + "/node_modules/bootstrap/dist/js/bootstrap.bundle.min.js"), type: js },
    "/assets/bootstrap.bundle.min.js.map": { obj: fs.readFileSync(__dirname + "/node_modules/bootstrap/dist/js/bootstrap.bundle.min.js.map"), type: js },
    "/assets/favicon.ico": { obj: fs.readFileSync(__dirname + "/favicon.ico"), type: "image/x-icon" },
    "/assets/socket.io.min.js": { obj: fs.readFileSync(__dirname + "/node_modules/socket.io/client-dist/socket.io.min.js"), type: js },
    "/assets/socket.io.min.js.map": { obj: fs.readFileSync(__dirname + "/node_modules/socket.io/client-dist/socket.io.min.js.map"), type: js },
    "/assets/nav.png": { obj: fs.readFileSync(__dirname + "/nav.png"), type: "image/png" },
    "/assets/client.js": { obj: fs.readFileSync(__dirname + "/client.js"), type: js }
};

const server = http.createServer((req, res) => {
    if (req.url.startsWith(url_base) && req.method === "GET") {
        try {
            const get = req.url.replace(url_base, "")
            res.writeHead(200, { "Content-Type": staticAssets[get].type });
            res.write(staticAssets[get].obj);
        } catch (error) {
            res.writeHead(404, { "Content-Type": html });
            res.write("Not Found");
        }
        res.end();
    } else if (req.url === url_base + "/list" && req.method === "POST") {
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

server.listen(port, () => {
    if (process.env.hide_ports || process.env.hide_ports == undefined)
        console.log(`Server listening on ${protocol}://${host}:${port}${url_base}`);
    else
        console.log(`Server listening on ${protocol}://${host}${url_base}`);
});
