/**
 * This file is part of TechnicServerPlatform.
 *
 * TechnicServerPlatform is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Lesser General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * TechnicServerPlatform is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with TechnicServerPlatform.  If not, see <http://www.gnu.org/licenses/>.
 */
var http = require("http");
var https = require("https");
var url = require("url");
var fs = require("fs");
var events = require("events");
var crypto = require("crypto");
var zip = require("node-zip");

http.globalAgent.maxSockets = 2;
https.globalAgent.maxSockets = 2;

var TEKKIT_MAIN_SOLDER = "https://solder.technicpack.net/api/";
var MOD_STATUS_FILENAME = ".mod_status.json";

function httpGet(urlStr, cb) {
	var urlObj = url.parse(urlStr);
	var _http = (urlObj.protocol === 'https:') ? https : http;
	return _http.get(urlStr, cb);
}

getModpackFromSolder(TEKKIT_MAIN_SOLDER, process.argv[2], process.argv[3]).on("fail", function(solderURL, modpack, build, e) {
		getSolderURLFromTechnicAPI(modpack, build).on("fail", function(modpack, build, e) {
			console.log("Error on modpack [" + modpack + "] on getting solder URL: " + e);
		}).on("success", function(modpack, build, solderURL) {
			getModpackFromSolder(solderURL, modpack, build).on("fail", function(solderURL, modpack, build, e) {
				console.log("Error on modpack [" + modpack + "] from solder [" + solderURL + "]: " + e);
			}).on("success", installModpackFromSolder);
		});
}).on("success", installModpackFromSolder);

function getSolderURLFromTechnicAPI(modpack, build) {
	var emitter = new events.EventEmitter();
	httpGet("https://www.technicpack.net/api/modpack/" + modpack, function(res) {
		var data = "";
		res.on("data", function(chunk) {
			data += chunk;
		});
		res.on("end", function() {
			data = JSON.parse(data);
			var solderURL = data.solder;
			if(solderURL) {
				emitter.emit("success", modpack, build, solderURL);
			} else
				emitter.emit("fail", modpack, build, "Could not find solder");
		});
	}).on("error", function(e) {
		console.log("Internal error getting solder for modpack [" + modpack + "]: " + e.message);
	});
	return emitter;
}

function getModpackFromSolder(solderURL, modpack, build) {
	if(solderURL.charAt(solderURL.length - 1) != "/")
		solderURL += "/";
	var emitter = new events.EventEmitter();
	httpGet(solderURL + "modpack/" + modpack, function(res) {
		var data = "";
		res.on("data", function(chunk) {
			data += chunk;
		});
		res.on("end", function() {
			data = JSON.parse(data);
			if(data.error) {
				emitter.emit("fail", solderURL, modpack, build, data.error);
				return;
			}

			emitter.emit("success", solderURL, modpack, build, data);
		});		
	}).on("error", function(e) {
		console.log("Internal error on modpack [" + modpack + "] from solder [" + solderURL + "]: " + e.message);
	});
	return emitter;
}

function downloadModAndInstall(mod, currentRetry, emitter) {
	if(!currentRetry)
		currentRetry = 1;
	emitter = emitter || new events.EventEmitter();
	httpGet(mod.url, function(res) {
		//res.setEncoding("binary");
		var data = [];
		var dataMD5 = crypto.createHash("md5");
		res.on("data", function(chunk) {
			data.push(chunk);
			dataMD5.update(chunk);
		});
		res.on("end", function() {
			dataMD5 = dataMD5.digest("hex");
			if(mod.md5 != dataMD5) {
				if(currentRetry > 3) {
					console.log("ERROR on downloading mod [" + mod.url + "]");
					emitter.emit("end", mod);
					return;
				}
				return downloadModAndInstall(mod, currentRetry + 1);
			}
			var zipFile = new zip(Buffer.concat(data));
			var zipContents = zipFile.files;
			var fileNames = [];
			for(var fileName in zipContents) {
				var fileContents = zipContents[fileName];
				if(fileContents.options.dir) {
					if(!fs.existsSync(fileName))
						fs.mkdirSync(fileName, 0755);
				} else {
					fs.writeFileSync(fileName, zipContents[fileName].asBinary(), {encoding: "binary", mode: 0644});
				}
				if(fileNames.indexOf(fileName) < 0)
					fileNames.push(fileName);
			}
			emitter.emit("end", mod, fileNames);
		});
	});	
	return emitter;
}

function deleteTrackedFilesOfMod(trackedFiles) {
	if(!trackedFiles)
		return;
	var dirs = [];
	for(var i in trackedFiles) {
		var file = trackedFiles[i];
		if(fs.existsSync(file)) {
			if(fs.statSync(file).isDirectory())
				dirs.push(file);
			else
				fs.unlinkSync(file);
		}
	}
	for(var i = dirs.length - 1; i >= 0; i--)
		try { fs.rmdirSync(dirs[i]); } catch(e) { }
}

function copyModpackJar(modpack, mcversion) {
	if(process.env.JAR_REPO && process.env.JAR_DEST) {
		var jarFrom = process.env.JAR_REPO.replace("%MCVERSION%", mcversion);
		console.log("Copying JAR for [" + modpack + "] from [" + jarFrom + "] to [" + process.env.JAR_DEST + "]");
		fs.writeFileSync(process.env.JAR_DEST, fs.readFileSync(jarFrom, {encoding: "binary"}), {encoding: "binary", mode: 0644});
	}
}

function installModpackFromSolder(solderURL, modpack, build, data) {
	switch(build) {
		case "latest":
			build = data.latest;
			break;
		case "recommended":
			build = data.recommended;
			break;
	}

	var modStatus = fs.existsSync(MOD_STATUS_FILENAME) ? fs.readFileSync(MOD_STATUS_FILENAME, {encoding: "utf8"}) : "";
	if(modStatus)
		modStatus = JSON.parse(modStatus);
	else
		modStatus = {};
	
	if(!modStatus.trackedFiles)
		modStatus.trackedFiles = {};
	if(!modStatus.build)
		modStatus.build = "N/A";
	if(!modStatus.modpack)
		modStatus.modpack = "N/A";
	if(!modStatus.buildInfo)
		modStatus.buildInfo = {};

	if(modStatus.build == build && modStatus.modpack == modpack) {
		console.log("Modpack [" + modpack + "] is already up to date");
		copyModpackJar(modpack, modStatus.mcversion);
		return;
	}

	if(modStatus.modpack != modpack)
		console.log("Swapping from [" + modStatus.modpack + " / " + modStatus.build + "] to [" + modpack + " / " + build + "]");
	else
		console.log("Updating [" + modpack + "] from build [" + modStatus.build + "] to [" + build + "]");

	httpGet(solderURL + "modpack/" + modpack + "/" + build + "?side=server", function(res) {
		var data = "";
		res.on("data", function(chunk) {
			data += chunk;
		});
		res.on("end", function() {
			data = JSON.parse(data);
			
			copyModpackJar(modpack, data.minecraft);
			
			var mods = data.mods;
			var buildInfo = {};
			var modCounter = 0;

			for(var i in mods) {
				var mod = mods[i];
				if (buildInfo[mod.name]) {
					throw 'Duplicate mod: ' + mod.name;
				}
				buildInfo[mod.name] = mod;
				modCounter++;
			}

			for(var modName in modStatus.buildInfo) {
				if(!buildInfo[modName]) {
					console.log("Removing obsolete mod [" + modName + "]");
					deleteTrackedFilesOfMod(modStatus.trackedFiles[modName]);
					delete modStatus.trackedFiles[modName];
				}
			}
			
			var exitStatus = 0;
			
			var decrementModCounterAndCheckForSave = function() {
				if(--modCounter < 1) {
					if (exitStatus !== 0) {
						throw 'Errors occcured';
					}
					modStatus.buildInfo = buildInfo;
					modStatus.build = build;
					modStatus.modpack = modpack;
					modStatus.mcversion = data.minecraft;
					fs.writeFileSync(MOD_STATUS_FILENAME, JSON.stringify(modStatus), {encoding: "utf8", mode: 0644});
				}
			};

			for(var modName in buildInfo) {
				var mod = buildInfo[modName];
				var oldMod = modStatus.buildInfo[modName];
				if(oldMod && oldMod.version == mod.version) {
					decrementModCounterAndCheckForSave();
					continue;
				}
				console.log("Updating mod [" + modName + "] from version [" + (oldMod ? oldMod.version : "N/A") + "] to [" + mod.version + "]");
				deleteTrackedFilesOfMod(modStatus.trackedFiles[mod.name]);
				downloadModAndInstall(mod).on("end", function(mod, trackedFiles) {
					if (trackedFiles) {
						modStatus.trackedFiles[mod.name] = trackedFiles;
					} else {
						exitStatus = 1;
					}
					decrementModCounterAndCheckForSave();
				});
			}
		});
	}).on("error", function(e) {
		console.log("Internal error on modpack [" + modpack + "] from solder [" + solderURL + "] in build [" + build + "]: " + e.message);
	});
}
