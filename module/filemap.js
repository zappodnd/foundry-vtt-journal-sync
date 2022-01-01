"use strict";
// filemap.js - Build a mapping between files and journal entries
//
// This will be used to optimize which files are saved/loaded based on what is changing.

import * as Constants from "./constants.js"
import * as Logger from './logger.js'

//
// Scan filesystem in the specified directories and build up a tree
// of journal entries that have already been exported, or edited by
// an external editor.
//
async function scanDirectoryTree(markdownpathopts, start_dir) {
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
	if (id === filesmall) {
	    id = undefined;
	}
	
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

	//Logger.log("Scanning Down to: " + subdir);
	
	subdirmap[idx] = await scanDirectoryTree(markdownpathopts, subdir);
	idx = idx+1;
    };

    let dirname = start_dir.split("/").pop();
    
    return { file: dirname,
	     name: dirname,
	     ondisk: true,
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
async function scanJournalTree() {
    // Create the set of folders derived from the current set of Journals.
    let journalFolders = game.folders.filter(f => (f.data.type === "JournalEntry") && f.displayed);
    
    let hashTable = Object.create(null);
    let dataTree = {
	name: validGameName(),
	subdirmap: [],
	journalmap: [],
	journal: undefined };

    // Add everything into the hash-table.
    journalFolders.forEach(folderEntity => hashTable[folderEntity.id] = {
	name: folderEntity.data.name,
	subdirmap: [],
	// Exclude anything that has a JSON like structure.
	journalmap: folderEntity.content.filter(j => !hasJSONStructure(j)),
	journal: folderEntity});

    // Once the hash is filled, we can build via the hash table.
    journalFolders.forEach(folderEntity => {
	if (folderEntity.data.parent) {
	    // Add to that parent's subdirmap.
            hashTable[folderEntity.data.parent].subdirmap.push(hashTable[folderEntity.id]);
        } else {
	    // A folder w/ no parent goes into the root data tree
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
// Create one FILE node for the merged journal tree.  Each FILE represents
// one journal entry / file.
// These are the items that go into the "FILES" slot in the tree structure.
//
function jfNode(file, jnode) {
    let newnode;

    // Assume that file & jnode are never both undefined.
    
    if (typeof file === "undefined") {
	newnode = { name: jnode.data.name,
		    file: undefined,
		    filetimestamp: undefined,
		    journaltimestamp: jnode.getFlag('journal-sync', 'LastModified'),
		    ondisk: false,
		    id: jnode.data._id,
		    journal: jnode,
		    // If there is no file, then by definition we need to save.  Always true.
		    save_needed: true,
		    // If there is no file, then no import is needed.
		    import_needed: false,
		    // No merge conflict if only a journal
		    merge_conflict: false
		  }
    } else if (typeof jnode === "undefined") {
	newnode = { name: file.name,
		    file: file.file,
		    filetimestamp: file.timestamp,
		    journaltimestamp: NaN,
		    ondisk: file.ondisk,
		    id: file.id,
		    journal: undefined,
		    save_needed: false, // No journal, no save needed
		    import_needed: true,// If there is no journal, then we surely must import
		    merge_conflict: false // No merge conflict if only a file

		  };
    } else {
	// If we have both, then we can do a nice merge.

	if (typeof file.id === "string" && jnode.data._id !== file.id) {
	    // TODO : multiple journals of same name ??
	    // Work on this merge more.
	    Logger.log(`${jnode.name}: ID for File Node ${file.name} does not match the found Journal of same name.`);
	    return undefined;
	}

	let jts = Math.floor(jnode.getFlag('journal-sync', 'LastModified') / 1000); // convert to seconds to match file timestamp
	let jdirty = jnode.getFlag('journal-sync', 'ExportDirty') ? true : false;
	let fdirty = isNaN(jts) || file.timestamp > jts;

	newnode = { name: file.name,
		    file: file.file,
		    filetimestamp: file.timestamp,
		    journaltimestamp: jts,
		    ondisk: file.ondisk,
		    id: jnode.data._id,
		    journal: jnode,
		    // If the journal is dirty then we need to save.
		    // If the dirty flag is undefined, but there is a file, then someone probably
		    // installed this module in an existing system with an old journal-sync - so no save needed.
		    save_needed: jdirty,
		    // If the file's reported timestamp is newer than the last edit time, then import is needed.
		    // If the journal has no record of saving, but there is a file, then likely an install over and older
		    // system.  We'll call these imports.
		    import_needed: fdirty,
		    // If we need to both save and import, then there is an issue.
		    merge_conflict: jdirty && fdirty
		  };
	
    }
    
    return newnode;
}


//
// Merge trees from scanDirectoryTree and scanJournalTree
// Create a new data structure that combines all the key bits of the two
// trees.
//
function mergeJournalAndFileTrees(filetree, journaltree) {

    // First, if either one of these is undefined, create a mock version
    // so we can finish the operation.
    if (typeof filetree === "undefined") {
	filetree = { name: journaltree.name,
		     file: journaltree.file,
		     ondisk: false,
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
		     ondisk: filetree.ondisk,
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

	//Logger.log(`${treenode.name}: File Attempt: ${file.name} Found: ${jidx}`);
	
	if (jidx == -1) {
	    newnode = jfNode(file,undefined);;
	} else {
	    let jnode=journals[jidx];
	    
	    newnode = jfNode(file, jnode);
	    
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
	//Logger.log(`${treenode.name}: Solo Journal: ${journal.name}`);

	let newnode = jfNode(undefined, journal);
	
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

	//Logger.log(`${treenode.name}: Subdir Attempt: ${subdir.name} Found: ${fidx}`);
	
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
	//Logger.log(`${treenode.name} Solo Folder: ${folder.name}`);
	let newnode = mergeJournalAndFileTrees(undefined, folder);
	treenode.subdir.push(newnode);
    };

    return treenode;
}

//
// Compute a data tree data structure that represents all the journal entries
// and their folders, plus all the files on disk that needs to be synched up.
//
export async function computeTreeForJournals(markdownPathOptions, dir) {

    let fmap = await scanDirectoryTree(markdownPathOptions, dir);

    let jmap = await scanJournalTree();

    let mmap = mergeJournalAndFileTrees(fmap, jmap);
    
    return mmap;
}

//
// UTILS
//

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

function hasJSONStructure(str) {
    if (typeof str !== 'string') return false;
    try {
        const result = JSON.parse(str);
        const type = Object.prototype.toString.call(result);
        return type === '[object Object]'
            || type === '[object Array]';
    } catch (err) {
        return false;
    }
}

function validGameName() {
    if (typeof game.world.name == "undefined") {
	// Version 8 of fvtt ?
	return game.world.data.name;
    } else {
	return game.world.name;
    }
}
//
// DELETE OBSOLETE BELOW
//


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
