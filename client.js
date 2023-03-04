"use strict";
function sockSetup() {
    //console.log("Sock setup started");
    const socket = io({ path: "/ytdiff/socket.io/" });
    socket.on("init", function (data) {
        // Need to make it so that the "acknowledge" is used somehow.
        socket.emit("acknowledge", { data: "Connected", id: data.id });
    });
    socket.on("download-start", function (data) {
        //console.groupCollapsed(`Downloading: ${data.message}`);
        toggleButton("off");
    });
    socket.on("progress", function (data) {
        //console.log(data.message);
        toggleButton("off");
    });
    socket.on("error", console.error.bind(console));
    socket.on("download-done", function (data) {
        //console.log(`Downloaded: ${data.message} ✅`);
        //console.groupEnd();
        toggleButton("on");
        showToast(`${data.message} ✅`);
    });
    socket.on("playlist-done", function (data) {
        //console.log(`Playlist: ${data.message} ✅`);
        //console.groupEnd();
        toggleButton("on");
        showToast(`${data.message} ✅`);
    });
};
function showToast(text) {
    const myToastEl = document.getElementById("notify");
    myToastEl.children[0].children[0].innerHTML = text;
    new bootstrap.Toast(myToastEl, {
        delay: 5000
    }).show();
}
function toggleButton(state) {
    const list_btn = document.getElementById("list_btn") || { disabled: false };
    const dnld_btn = document.getElementById("download_btn");
    switch (state) {
        case "off":
            // Check if on then turn off
            if ((list_btn.disabled == false) && (dnld_btn.disabled == false)) {
                list_btn.disabled = true;
                dnld_btn.disabled = true;
            }
            break;
        case "on":
            // turn on the buttons
            list_btn.disabled = false;
            dnld_btn.disabled = false;
            break;
        default:
            break;
    }
}

// Listing method
function listVideos() {
    try {
        var url = new URL(document.getElementById("url").value);
        if (url.protocol == "https:" || url.protocol == "http:") {
            url = url.href;
            // Setting the global url
            url_global = url;
        } else {
            throw new Error("Not a valid URL");
        }
        const [start_val, stop_val] = getLimits(0, "start_sublist", "stop_sublist", "chunk_sublist");
        const chunk_sublist = +document.getElementById("chunk_sublist").value;
        toggleButton("off");
        //console.log("URL: " + url, "Start: " + start, "Stop: " + stop, "Chunk size: " + chunk);
        fetch("/ytdiff/list", {
            method: "post",
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                url: url,
                start: start_val,
                stop: stop_val,
                chunk: chunk_sublist,
                watch: false,
                full_update: false,
            })
        }).then((response) => response.text()).then(makeSubTable);
    } catch (err) {
        //console.error(err);
        showToast(`Not a valid URL ❌`);
    }
};

// Limit setter
function getLimits(mode, start_id, stop_id, chunk_id) {
    var start_val = +document.getElementById(start_id).value;
    var stop_val = +document.getElementById(stop_id).value;
    const chunk = +document.getElementById(chunk_id).value;
    // Setting start value if it's not set in DOM yet
    if (isNaN(start_val)) {
        start_val = 0;
    }
    // Setting stop value if it's not set in DOM yet
    if (isNaN(stop_val)) {
        stop_val = start_val + chunk;
    }
    switch (mode) {
        // This for next
        case 1:
            start_val = start_val + chunk;
            stop_val = stop_val + chunk;
            break;
        // This for back
        case 2:
            if ((start_val - chunk) <= 0) {
                start_val = 0;
            } else {
                start_val = start_val - chunk;
            }
            // Setting stop value
            if ((stop_val - chunk) <= chunk) {
                stop_val = chunk;
            } else {
                stop_val = stop_val - chunk;
            }
            break;
        default:
            break;
    }
    document.getElementById(start_id).value = start_val;
    document.getElementById(stop_id).value = stop_val;
    return [start_val, stop_val];
}
// Ui limit setter
function inputLimiter(evt) {
    evt.preventDefault()
    //console.log(evt.explicitOriginalTarget.id, evt.inputType, evt.target.value);
    var value = +evt.target.value;
    const start_sublist = +document.getElementById("start_sublist").value;
    const start_playlist = +document.getElementById("start_playlist").value;
    const chunk_sublist = +document.getElementById("chunk_sublist").value;
    const chunk_playlist = +document.getElementById("chunk_playlist").value;
    switch (evt.explicitOriginalTarget.id) {
        case "chunk_sublist":
            if (value >= 1) {
                document.getElementById("stop_sublist").value = start_sublist + value;
            } else {
                evt.target.value = 1;
            }
            break;
        case "chunk_playlist":
            if (value >= 1) {
                document.getElementById("stop_playlist").value = start_playlist + value;
            }
            else {
                evt.target.value = 1;
            }
            break;
        case "start_sublist":
            if (value >= 0) {
                document.getElementById("stop_sublist").value = chunk_sublist + value;
            }
            else {
                evt.target.value = 0;
            }
            break;
        case "start_playlist":
            if (value >= 0) {
                document.getElementById("stop_playlist").value = chunk_playlist + value;
            }
            else {
                evt.target.value = 0;
            }
            break;
        case "stop_sublist":
            if (value >= 1) {
                if (value - start_sublist >= 1)
                    document.getElementById("chunk_sublist").value = value - start_sublist;
                else {
                    document.getElementById("stop_sublist").value = value + 1;
                    document.getElementById("chunk_sublist").value = 1;
                }
            }
            else {
                evt.target.value = 1;
            }
            break;
        case "stop_playlist":
            if (value >= 1) {
                if (value - start_playlist >= 1)
                    document.getElementById("chunk_playlist").value = value - start_playlist;
                else {
                    document.getElementById("stop_playlist").value = value + 1;
                    document.getElementById("chunk_playlist").value = 1;
                }
            }
            else {
                evt.target.value = 1;
            }
            break;
        default:
            break;
    }
}
const debounce = function (fn, d) {
    var timer;
    return function () {
        clearTimeout(timer);
        timer = setTimeout(() => {
            fn.apply();
        }, d);
    }
}
const onFinishTyping = debounce(searchSub, 500);

// Main list methods
function getMainList(mode = 0) {
    const sort_val = document.getElementById("sort_by_playlist").value;
    const order_val = document.getElementById("order_by_playlist").value;
    const [start_val, stop_val] = getLimits(mode, "start_playlist", "stop_playlist", "chunk_playlist");
    //console.log("Start: " + start_val + " stop: " + stop_val);
    fetch("/ytdiff/dbi", {
        method: "post",
        headers: {
            "Accept": "application/json",
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            start: start_val,
            stop: stop_val,
            sort: sort_val,
            order: order_val
        })
    }).then((response) => response.text()).then(makeMainTable);
};
function makeMainTable(text) {
    const table = document.getElementById("placeholder");
    // It feels that clearing the table before parsing the JSON makes it seem less laggy
    for (var i = 0; i < table.rows.length;) {
        table.deleteRow(i);
    }
    text = JSON.parse(text)
    //const options = { year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "numeric" };
    text["rows"].forEach(element => {
        /*
        id 	url 	createdAt 	updatedAt 	more
        */
        //console.log(element);
        const row = table.insertRow();
        const id = row.insertCell(0);
        const url = row.insertCell(1);
        //const createdAt = row.insertCell(2);
        const updated_days_ago = row.insertCell(2);
        //const watch = row.insertCell(3);
        const show = row.insertCell(3);

        id.innerHTML = element.order_added;
        url.innerHTML = `<a href="${element.url}">${element.title}</a>`;
        //console.log(element.updatedAt);
        updated_days_ago.className = "extra";
        updated_days_ago.innerHTML = Math.floor((new Date().getTime() - new Date(element.updatedAt).getTime()) / (1000 * 3600 * 24)) + " days ago";
        // single quotes are necessary here / or i can make a dynamic button
        show.innerHTML = '<button type="button" class="btn btn-secondary" onclick=getSubList("' + element.url + '")>Load</button>';
        //createdAt.innerHTML = new Date(element.createdAt).toLocaleDateString("en-US", options);
        //const checkbox = document.createElement("input");
        //checkbox.type = "checkbox";
        //checkbox.className = "form-check-input me-1 update-markers";
        // Now I have an Idea that is to add an event listener to the class of update-makers
        // whenever one of them is checked or uncheck the playlist url is sent as an xhr request
        // that will be recieved and consequently mark the playlist to be updated whenever the
        // next scheduled update is, but I still have no idea how to handle the full update thing
        //checkbox.checked = element.watch;
        //checkbox.id = element.order_added;
        //checkbox.oninput = function (event) {
        //    event.preventDefault();
        //    fetch("/ytdiff/watchlist", {
        //        method: "post",
        //        headers: {
        //            "Accept": "application/json",
        //            "Content-Type": "application/json"
        //        },
        //        body: JSON.stringify({
        //            url: event.target.parentElement.parentElement.children[1].children[0].href.valueOf(),
        //            watch: event.target.checked,})});};
        //watch.className = "text-center";
        //watch.appendChild(checkbox);
    });
}

// Main list utilities
function nextMain() {
    getMainList(1);
};
function backMain() {
    getMainList(2);
};
function sortLoaded() {
    getMainList(0);
}

//Sub list making methods
function getSubList(url, mode = 0, query_str = "", clear_query = true) {
    const [start_val, stop_val] = getLimits(mode, "start_sublist", "stop_sublist", "chunk_sublist");
    // Setting the url_global variable so that next request can use it again
    if (url_global != url) {
        url_global = url;
    }
    // Checking the clear_query and modifying it
    if (clear_query) {
        document.getElementById("query_sublist").value = "";
        query_str = "";
    }
    //console.log("Getting url: ", url_global, " start: ", start, " stop: ", stop, "query: ", query_str);
    fetch("/ytdiff/getsub", {
        method: "post",
        headers: {
            "Accept": "application/json",
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            url: url,
            start: start_val,
            stop: stop_val,
            query: query_str
        })
    }).then((response) => response.text()).then(makeSubTable);
};
function makeSubTable(text) {
    clearSubList();
    const table = document.getElementById("listing");
    const data = JSON.parse(text);
    //console.log(data);
    data["rows"].forEach(element => {
        /*
            # 	Title 	Downloaded 	Available
        */
        const row = table.insertRow();
        const select = row.insertCell(0);
        const title = row.insertCell(1);
        const download = row.insertCell(2);

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.className = "form-check-input me-1 video-item";
        checkbox.value = "";
        checkbox.id = element.id;

        const link = document.createElement("a");
        link.href = element.url;
        link.appendChild(document.createTextNode(element.title));
        select.className = "text-center";
        select.appendChild(checkbox);
        title.className = "large-title";
        title.appendChild(link);
        download.className = "emoji";
        if (element.downloaded) {
            download.innerHTML = "✅";
        } else {
            download.innerHTML = "❌";
        }
        if (element.downloaded) {
            row.className = "table-info";
        }
        if (!element.available) {
            if (element.title == "[Deleted video]")
                row.className = "table-danger";
            else if (element.title == "[Private video]")
                row.className = "table-warning"
            else
                row.className = "table-secondary"
        }
    });
};

//Sub list utilities
function clearSubList(reset = false) {
    const table = document.getElementById("listing");
    for (var i = 0; i < table.rows.length;) {
        table.deleteRow(i);
    }
    if (reset) {
        document.getElementById("start_sublist").value = 0;
        document.getElementById("stop_sublist").value = 10;
        document.getElementById("chunk_sublist").value = 10;
        try {
            document.getElementById("url").value = "";
        } catch (error) {
            //Nothing
        }
        url_global = "None";
    }
};
function searchSub() {
    var query = document.getElementById("query_sublist").value.trim();
    getSubList(url_global, 0, query, false);
};
function nextSub() {
    var query = document.getElementById("query_sublist").value.trim();
    getSubList(url_global, 1, query, false);
};
function backSub() {
    var query = document.getElementById("query_sublist").value.trim();
    getSubList(url_global, 2, query, false);
};
function selectAll() {
    document.querySelectorAll("input[type=checkbox].video-item").forEach(element => {
        element.checked = true;
    });
};
function selectNone() {
    document.querySelectorAll("input[type=checkbox].video-item").forEach(element => {
        element.checked = false;
    });
};
function downloadSelected() {
    toggleButton("off");
    const request_list = { id: [] };
    document.querySelectorAll("input[type=checkbox].video-item:checked").forEach(element => {
        request_list['id'].push(element.id);
    })
    fetch("/ytdiff/download", {
        method: "post",
        headers: {
            "Accept": "application/json",
            "Content-Type": "application/json"
        },
        body: JSON.stringify(request_list)
    });//.then((response) => response.text()).then(console.log);
};