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

//
// Scan filesystem in the specified directories and build up a tree
// of journal entries that have already been exported, or edited by
// an external editor.
//
export async function scanDirectoryTree(markdownpathopts, start_dir) {
    // Scan directories and build out a tree of all the files on disk.

    //Logger.log("Start Dir: " + start_dir)

    start_dir = start_dir.replace(/\/$/, '');
    
    let result = await FilePicker.browse(markdownpathopts.activeSource, start_dir);

    let timestamp = await result.files.filter(file => file.indexOf("jsTimestamps.txt") !== -1);
    let stamps = [];
    
    if (timestamp.length == 1) {
	// If there was a timestamp file, load it in.
	let response = await fetch(timestamp[0]);
	let contents = await response.text();

	stamps = scrape_timestamp_file(contents);
    }

    // Regardless of if there is a timestamp file, scan this directory for files.
    // For each .md file we found, build up a map of actual files, files in the timestamp file
    // and known journal entry keys

    let markdown = await result.files.filter(file => file.indexOf(".md") !== -1);
    let filemap = [];

    let idx = 0;
    for (let fidx=0; fidx<markdown.length; fidx++) {
	//await markdown.forEach((file, key, map) => {
	let file = markdown[fidx];
	let filesmall = decodeURIComponent(file).replace(start_dir+"/", '');
	let s = stamps.find(o => {
	    // Logger.log(`${o.file} == ${filesmall}`);
	    return filesmall == o.file });

	let ts = undefined;
	// Logger.log(s)
	if (typeof s !== "undefined") {
	    ts = s.timestamp;
	}

	// Old School version of journal-sync stored the id in the file name.
	// Extract it here.  (It should be ok to do this.)
	let id = filesmall.split(' (').pop().replace(').md', '');
	
	// This works regardless of if there is an id in the name or not.
	let name = filesmall.replace(` (${id}).md`, '').replace('.md', '');
	
	filemap[idx] = { file: filesmall,
			 name: name,
			 id: id,
			 timestamp: ts,
			 ondisk: true
		       }
	idx=idx+1;
    };


    // Loop over all the directories, and scan downward
    let subdirmap = [];
    idx = 0;
    for (let sdidx=0; sdidx<result.dirs.length; sdidx++) {
	let dir=result.dirs[sdidx];
	let dirsmall = decodeURIComponent(dir).replace(start_dir+"/", '');
	let subdir = start_dir + "/" + dirsmall;

	Logger.log("Scanning Down to: " + subdir);
	
	subdirmap[idx] = await scanDirectoryTree(markdownpathopts, subdir);
	idx = idx+1;
    };

    let dirname = start_dir.split("/").pop();
    
    return { file: dirname,
	     name: dirname,
	     id: '',
	     filemap: filemap,
	     subdirmap: subdirmap };


	//fetch(file).then(response => response.blob())
	//	.then(blob => {
	//	    const file = new File([blob], blob.name);
	//	    Logger.log(file);
	//	    // Logger.log(file.lastModifiedDate, file.lastModified);
	//	});
	//
}

//
// Scan the game journals and store them all into a tree.
//
export async function scanJournalTree() {
    // Create the set of folders derived from the current set of Journals.
    let journalFolders = game.folders.filter(f => (f.data.type === "JournalEntry") && f.displayed);
    
    let hashTable = Object.create(null);
    let dataTree = {
	name: game.world.data.name,
	subdirmap: [],
	journalmap: [],
	journal: undefined };

    // Add everything into the hash-table.
    journalFolders.forEach(folderEntity => hashTable[folderEntity.id] = {
	name: folderEntity.data.name,
	subdirmap: [],
	journalmap: folderEntity.content,
	journal: folderEntity});

    // Once the hash is filled, we can build via the hash table.
    journalFolders.forEach(folderEntity => {
	if (folderEntity.data.parent) {
            hashTable[folderEntity.data.parent].subdirmap.push(hashTable[folderEntity.id]);
        } else {
            dataTree.subdirmap.push(hashTable[folderEntity.id]);
        }
    })

    // After scanning all the folders that hold journals, look for all journals that
    // are not in a folder.  These go into the base of the data tree.
    game.journal.filter(f => (f.data.folder === null)).forEach((value, key, map) => {
	dataTree.journalmap.push(value);
    });

    
    return dataTree;
}

//
// Merge trees from scanDirectoryTree and scanJournalTree
// Create a new data structure that combines all the key bits of the two
// trees.
//
export function mergeJournalAndFileTrees(filetree, journaltree) {

    // First, if either one of these is undefined, create a mock version
    // so we can finish the operation.
    if (typeof filetree === "undefined") {
	filetree = { name: journaltree.name,
		     file: journaltree.file,
		     filemap: [],
		     subdirmap: [],
		     id: "" };
    }
    
    if (typeof journaltree === "undefined") {
	journaltree = { journal: undefined,
			    name: filetree.name,
			    journalmap: [],
			    subdirmap: [],
			    id: "" };
    }

    
    // First, verify they are synchronized
    if (filetree.name !=="" && journaltree.name !== "" && filetree.name !== journaltree.name) {
	Logger.log("Trees don't match!");
	return;
    }
    
    let treenode = { name: filetree.name,
		     file: filetree.file,
		     journal: journaltree.journal,
		     files: [],
		     subdir: [] };

    let files = filetree.filemap;
    let journals = journaltree.journalmap;

    //Logger.log(`${treenode.name} Journal Length Before: ${journals.length}`);
    for (let idx=0; idx < files.length; idx++) {
	let file = files[idx];
	let jidx = journals.findIndex(j => {
	    return file.name === j.data.name; });
	let newnode;

	Logger.log(`${treenode.name}: File Attempt: ${file.name} Found: ${jidx}`);
	
	if (jidx == -1) {
	    newnode = { name: file.name,
			file: file.file,
			filetimestamp: file.timestamp,
			ondisk: file.ondisk,
			id: file.id,
			journal: undefined
		      };
	} else {
	    let jnode=journals[jidx];
	    
	    
	    if (typeof file.id === "string" && jnode.data._id !== file.id) {
		// TODO : multiple journals of same name ??
		// Work on this merge more.
		Logger.log(`${treenode.name}: ID for File Node ${file.name} does not match the found Journal of same name.`);
	    }
	    
	    newnode = { name: file.name,
			file: file.file,
			filetimestamp: file.timestamp,
			ondisk: file.ondisk,
			id: jnode.data._id,
			journal: jnode	    
		      };

	    // Remove the found node from the list of journals
	    journals.splice(jidx,1);
	}

	// Add newnode into the list.
	treenode.files.push(newnode);
    }

    // The only things left in "journals" will be content that has no file.
    //Logger.log(`${treenode.name} Journal Length After: ${journals.length}`);
    for (let idx=0; idx<journals.length; idx++) {
	let journal = journals[idx];
	Logger.log(`${treenode.name}: Solo Journal: ${journal.name}`);

	let newnode = { name: journal.data.name,
			file: undefined,
			filetimestamp: undefined,
			ondisk: false,
			id: journal.data._id,
			journal: journal	    
		      };
	treenode.files.push(newnode);
    };

    // Now recurse for all the subdirectories
    let dirs = filetree.subdirmap;
    let folders = journaltree.subdirmap;

    //Logger.log(dirs)
    //console.log("foo")
    
    for (let idx=0; idx<dirs.length; idx++) {
	let subdir = dirs[idx];
	//Logger.log(subdir)
	let fidx = folders.findIndex(f => { return subdir.name === f.name} );
	let newnode;

	Logger.log(`${treenode.name}: Subdir Attempt: ${subdir.name} Found: ${fidx}`);
	
	if (fidx == -1) {
	    newnode = mergeJournalAndFileTrees(subdir, undefined);
	} else {
	    let jfnode = folders[fidx];

	    newnode = mergeJournalAndFileTrees(subdir, jfnode);
	    // Remove the found node from the list of journals
	    folders.splice(fidx,1);
	}

	treenode.subdir.push(newnode);
    };
    
    // Cleanup left over journal folders
    for (let idx=0; idx<folders.length; idx++) {
	let folder = folders[idx];
	Logger.log(`${treenode.name} Solo Folder: ${folder.name}`);
	let newnode = mergeJournalAndFileTrees(undefined, folder);
	treenode.subdir.push(newnode);
    };

    return treenode;
}


export async function createJournalFolderTree() {
    // Create the set of folders derived from the current set of Journals.
    let journalFolders = game.folders.filter(f => (f.data.type === "JournalEntry") && f.displayed);
    
    let hashTable = Object.create(null);
    let dataTree = [];

    // Add everything into the hash-table.
    journalFolders.forEach(folderEntity => hashTable[folderEntity.id] = {
	data : folderEntity.data,
	content : folderEntity.content,
	children : folderEntity.children,
	childNodes : [] });

    // Once the hash is filled, we can build via the hash table.
    journalFolders.forEach(folderEntity => {
	if (folderEntity.data.parent) {
            hashTable[folderEntity.data.parent].childNodes.push(hashTable[folderEntity.id]);
        } else {
            dataTree.push(hashTable[folderEntity.id]);
        }
    })
    return dataTree;
    

}
