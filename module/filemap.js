"use strict";
// filemap.js - Build a mapping between files and journal entries
//
// This will be used to optimize which files are saved/loaded based on what is changing.

import * as Constants from "./constants.js"
import * as Logger from './logger.js'

function scrape_timestamp_file(contents) {

    let linearray = contents.split(/\r\n|\n/);
    let parsedarray = [];
    let idx = 0;
    linearray.forEach((line, key) => {
	let colonsplit = line.split(/:/);
	if (colonsplit.length == 2) {
	    parsedarray[idx] = { file: colonsplit[0],
				 timestamp: parseInt(colonsplit[1],10) };
	    idx = idx+1;
	}
    });
    return parsedarray;
}


export async function scanDirectoryTree(markdownpathopts, start_dir) {
    // Scan directories and build out a tree of all the files on disk.

    //Logger.log("Start Dir: " + start_dir)

    start_dir = start_dir.replace(/\/$/, '');
    
    let result = await FilePicker.browse(markdownpathopts.activeSource, start_dir);

    let timestamp = result.files.filter(file => file.indexOf("jsTimestamps.txt") !== -1);
    let stamps = [];
    
    if (timestamp.length == 1) {
	// If there was a timestamp file, load it in.
	let contents = await fetch(timestamp[0]).then(response => response.text());

	stamps = scrape_timestamp_file(contents);
    }

    // Regardless of if there is a timestamp file, scan this directory for files.
    // For each .md file we found, build up a map of actual files, files in the timestamp file
    // and known journal entry keys

    let markdown = result.files.filter(file => file.indexOf(".md") !== -1);
    let filemap = [];

    let idx = 0;
    markdown.forEach((file, key, map) => {
	let filesmall = decodeURIComponent(file).replace(start_dir+"/", '');
	let s = stamps.find(o => {
	    // Logger.log(`${o.file} == ${filesmall}`);
	    return filesmall == o.file });

	let ts = undefined;
	// Logger.log(s)
	if (typeof s !== "undefined") {
	    ts = s.timestamp;
	}
	
	// TODO - also find the matching journal key
	// Use that to decide if we have merge conflicts.
	filemap[idx] = { file: filesmall,
			 timestamp: ts,
			 ondisk: true
		       }
	idx=idx+1;
    });


    // Loop over all the directories, and can downward
    let subdirmap = [];
    idx = 0;
    result.dirs.forEach(async (dir, key, map) => {
	let dirsmall = decodeURIComponent(dir).replace(start_dir+"/", '');
	let subdir = start_dir + "/" + dirsmall;

	Logger.log("Scanning Down to: " + subdir);
	
	subdirmap[idx] = await scanDirectoryTree(markdownpathopts, subdir);
	idx = idx+1;
    });

    return { filemap: filemap,
	     subdirmap: subdirmap };


	//fetch(file).then(response => response.blob())
	//	.then(blob => {
	//	    const file = new File([blob], blob.name);
	//	    Logger.log(file);
	//	    // Logger.log(file.lastModifiedDate, file.lastModified);
	//	});
	//
}


export function journalKeyMap() {

}

