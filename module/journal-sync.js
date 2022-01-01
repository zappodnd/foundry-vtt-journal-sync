"use strict";
import * as Constants from "./constants.js"
import * as Logger from './logger.js'
import * as FileMap from './filemap.js'

let markdownPathOptions, markdownSourcePath, journalEditorLink, importWorldPath, exportWorldPath;
let enableTracing = false;
let newImportedFiles = "";
let skippedJournalFolders, skippedJournalEntries;

// parses the string back to something the FilePicker can understand as an option
export function parse(str) {
  let matches = str.match(/\[(.+)\]\s*(.+)/);
  if (matches) {
    let source = matches[1];
    const current = matches[2].trim();
    const [s3, bucket] = source.split(":");
    if (bucket !== undefined) {
      return {
        activeSource: s3,
        bucket: bucket,
        current: current,
      };
    } else {
      return {
        activeSource: s3,
        bucket: null,
        current: current,
      };
    }
  }
  // failsave, try it at least
  return {
    activeSource: "data",
    bucket: null,
    current: str,
  };
}

export async function fetchParams(silent = false) {
    markdownPathOptions = parse(game.settings.get(Constants.MODULE_NAME, "MarkdownSourcePath"));
    markdownSourcePath = markdownPathOptions.current;

    journalEditorLink = game.settings.get(Constants.MODULE_NAME, "JournalEditorLink");
    enableTracing = game.settings.get(Constants.MODULE_NAME, "EnableTracing");
    
    importWorldPath = game.settings.get(Constants.MODULE_NAME, "ImportWorldPath");
    exportWorldPath = game.settings.get(Constants.MODULE_NAME, "ExportWorldPath");

    skippedJournalFolders = game.settings.get(Constants.MODULE_NAME, "SkipJournalFolders").split(',');
    skippedJournalEntries = game.settings.get(Constants.MODULE_NAME, "SkipJournalEntries").split(',');

    // If the entries are empty it will set the array to one empty string ""
    // This matches the root path where the folder name is also 
    // "" so blocked export/import. If nothing set put a name in that no
    // one in their right mind would use :)
    if(skippedJournalFolders.length == 1 && skippedJournalFolders[0] === "") {
        skippedJournalFolders[0] = "NOTHINGHASBEENSETTOSKIP";
    }
    if(skippedJournalEntries.length == 1 && skippedJournalEntries[0] === "") {
        skippedJournalEntries[0] = "NOTHINGHASBEENSETTOSKIP";
    }
}

/**
 * Runs during the init hook of Foundry
 *
 * During init the settings and trace logging is set.
 *
 */
export async function initModule() {
    Logger.log("Init Module entered")
    await fetchParams(true);
    if (enableTracing) {
        Logger.enableTracing();
    }

    // Use Chat Commands Lib to register some new chat commands
    Hooks.on("chatCommandsReady", function(chatCommands) {
    
    	Logger.log("Registering chat commands")
    	
    	// GM Only command that will do the journal sync activity
    	chatCommands.registerCommand(chatCommands.createCommandFromData({
    	    commandKey: "/js",
    	    invokeOnCommand: async (chatlog, messageText, chatdata) => {
		switch (messageText) {
		case "help":
		    return "This is a help string";
		    
		case "test": // /js test
		    let dir = validMarkdownSourcePath()+validImportWorldPath();
		    Logger.log('Starting TEST sequence at ' + dir);

		    let mmap = await FileMap.computeTreeForJournals(markdownPathOptions, dir);
		    Logger.log("Merged Map");
		    Logger.log(mmap);

		    let actions = await computeSyncActions(mmap);
		    Logger.log("Computed Actions");
		    Logger.log(actions);

		    ChatMessage.create({content: "journal-sync: Actions Needed:<ol>" +
					actions.map(a=>"<li>" + a.action +
						    " \"" + a.what.name +
						    "\" " + a.where).join('')
					+ "</ol>"});
		    return;

		case "export":
		    commandExport();
		    //startExport();
		    return;
		    
		case "import":
		    commandImport();
		    //startImport();
		    return;

		//case "nukejournals":
                //    game.journal.forEach((value, key, map) => { JournalEntry.delete(value.id); });
		//    return;
		//    
		//case "nukefolders":
                //    game.journal.forEach((value, key, map) => { JournalEntry.delete(value.id); });
		//    return;
		    
		default:
		    ChatMessage.create({content: "Unknown journal-sync command:\n  " + messageText});
		    return;
		}
		
    	    },
    
    	    shouldDisplayToChat: false,
    	    iconClass: "fa-sticky-note",
    	    description: "Synchronize Journals for external editors",
    	    gmOnly: true
    	}));
    });
}

// ---------
//
// Track how journals in FVTT change, and what needs to happen to them.
//
// ---------
function journalModifiedHookFcn(journalEntry, d, opts, userId) {
    let dirty = journalEntry.getFlag('journal-sync', 'ExportDirty');
    let mods = journalEntry.getFlag('journal-sync', 'LastModified');

    // Only mark as dirty if the "content", "folder" or "name" changed.
    if ( "content" in d || "name" in d || "folder" in d ) {
	setJournalSyncDirty(journalEntry, true);
	Logger.log(`Journal "${journalEntry.data.name}" changed`);
    } else {
	//Logger.log("Journal Flags or other Changed");
    }
}

function setJournalSyncDirty(journalEntry, dirty, modified=false) {
    // Set the dirty flag as specified.
    journalEntry.setFlag('journal-sync', 'ExportDirty', dirty);

    // If this journal is now dirty, then also set lastmodified.
    // If it is clean, then leave the old modified flag.
    if (dirty || modified) {
	journalEntry.setFlag('journal-sync', 'LastModified', Date.now());
    }
}

// ---------
//
// Setup the module.
//
// ---------
export async function readyModule() {
    Logger.log("Ready Module entered")
    await fetchParams();

    Logger.log(`markdownSourcePath: ${markdownSourcePath}`)
    Logger.log(`validMarkdownSourcePath(): ${await validMarkdownSourcePath()}`)

    // Create markdownSourcePath if not already there.
    let buildPath = '';
    validMarkdownSourcePath().split('/').forEach((path) => {
        buildPath += path + '/';
        FilePicker.createDirectory(markdownPathOptions.activeSource, buildPath)
            .then((result) => {
                Logger.log(`Creating ${buildPath}`);
            })
            .catch((error) => {
                if (!error.includes("EEXIST")) {
                    Logger.log(error);
                }
            });
    });

    Hooks.on("getSceneControlButtons", (controls) => {
        let group = controls.find(function(b) {
	    return b.name == "notes" });
        group.tools.push({
            name: "import",
            title: "Import Journals",
            icon: "fas fa-file-import",
            onClick: () => {
                startImport();
            },
            button: true
        });
        group.tools.push({
            name: "export",
            title: "Export Journals",
            icon: "fas fa-file-export",
            onClick: () => {
                startExport();
            },
            button: true,
        });

        if (journalEditorLink != "") {
            group.tools.push({
                name: "edit",
                title: "Edit Journals",
                icon: "fas fa-edit",
                onClick: () => {
                    window.open(journalEditorLink, "_blank");
                },
                button: true,
            });
        }
    });

    // Initialize tracking journal edits so we can auto-sync
    Hooks.on("updateJournalEntry", journalModifiedHookFcn);
}

// ---------
//
// COMPUTE ACTIONS:  Identify what needs to be done.
//
// ---------
async function computeSyncActions(mmap) {
    // Compute the journal/file tree, and scan the tree for actions needed.
    // Return a list of actions that are needed.
    if (typeof mmap === "undefined") {
	let dir = validMarkdownSourcePath()+validImportWorldPath();
	mmap = await FileMap.computeTreeForJournals(markdownPathOptions, dir);
    }

    let actions = [];

    let fcn = function (lmmap, pathaccum) {
	let path = pathaccum + "/" + lmmap.file;
	let jfolder = lmmap.journal;
	
	// Step 1: Do we need to make this directory?
	if (!lmmap.ondisk) {
	    actions.push({ action: "mkdir",
			   what: lmmap,
			   where: path,
			   jwhere: jfolder });
	}

	// Step 2: Loop over all the files
	for (let idx=0; idx < lmmap.files.length; idx++) {
	    let f = lmmap.files[idx];

	    // Step 2.1: Save merge conflicts.
	    if (f.merge_conflict) {
		actions.push({ action: "conflict",
			       what: f,
			       where: path,
			       jwhere: jfolder });
	    } else {
		// Step 2.2: Save exports
		if (f.save_needed) {
		    actions.push({ action: "export",
				   what: f,
				   where: path,
				   jwhere: jfolder });

		    
		} else
		    // Step 2.3: Save imports
		    if (f.import_needed) {
			actions.push({ action: "import",
				       what: f,
				       where: path,
				       jwhere: jfolder });
		    } else {
			//Logger.log(`No Action needed on ${f.name}`);
		    }
	    }
	}

	// Step 3: Loop over subdirs and recurse
	for (let idx=0; idx < lmmap.subdir.length; idx++) {
	    fcn(lmmap.subdir[idx], path);
	}
    };
    
    fcn(mmap,"",undefined);
    
    return actions;
}

function actionPath(action) {
    let fullpath = (validMarkdownSourcePath()+action.where).replace("//", "/").trim();
    //Logger.log(`Action Path: ${fullpath}`);
    return fullpath;
};

// ---------
//
// DO ACTIONS:  Functions that will do needed actions of specific types.
//
// ---------
async function doActionMkdir(action) {
    // Take an action (see computeSyncActions) and create the needed directory

    let path = actionPath(action);
    
    Logger.log("doAction: MKDIR: " + path);
    await FilePicker.createDirectory(markdownPathOptions.activeSource, path).catch((error) => {
        if (!error.includes("EEXIST")) {
            Logger.log(error);
        } else {
            Logger.log(`Path ${path} exists`);
        }	
    });

}

async function doActionExport(action) {
    // Take an action (see computeSyncActions) and export that item.

    let path = actionPath(action);
    let md = "";
    let journalFileName = action.what.file;

    if (typeof journalFileName === "undefined") {
	// Never been saved?  Generate a nice name.
	journalFileName = generateJournalFileName(action.what.journal);
    }

    Logger.log("doAction: Export: " + action.what.name + " -> " + path + "/" + journalFileName);
        
    var converter = new showdown.Converter({ tables: true, strikethrough: true });
    md = converter.makeMarkdown(action.what.journal.data.content).split('\r\n');

    let blob = new Blob([md], {type: "text/markdown"});
    let file = new File([blob], journalFileName, {type: "text/markdown"});

    FilePicker.upload(markdownPathOptions.activeSource, path, file, { bucket: null })
        .then((result) => {
            Logger.log(`Uploading ${markdownPathOptions.activeSource}/${path}`);
        })
        .catch((error) => {
            Logger.log(error);
        });

    // Mark as clean (doesn't need to save anymore)
    setJournalSyncDirty(action.what.journal, false);    
}

async function doActionImport(action) {
    // Take an action (see computeSyncActions) and import that item.
    let path = actionPath(action);
    let md = "";
    let journalFileName = action.what.file;
    let fname = path + "/" + journalFileName;
    Logger.log("doAction: import: " + action.what.name + " <- " + fname);

    let journal = action.what.journal;
    
    // Journal should be valid to import into.
    fetch(fname).then(response => {
	response.text().then(contents => {

            // If the contents is pure JSON ignore it as it may be used by 
            // a module as configuration storage.
            if (hasJsonStructure(contents)) {
                md = contents;
            } else {
                var converter = new showdown.Converter({ tables: true, strikethrough: true })
                md = converter.makeHtml(contents);
            }

	    if (typeof journal === "undefined") {
		JournalEntry.create({ name: action.what.name, content: md, folder: action.jwhere,
				      flags: { 'journal-sync': { ExportDirty: false,
								 LastModified: Date.now() }}});
	    } else {
		journal.update({contents: md}); // This doesn't call our hook?
		setJournalSyncDirty(journal, false, true);// Set not dirty, but also set modified hook.
	    }
	    Logger.log(`doAction: import: Async import done for ${fname}`);
	    
	}).catch(error => {
	    Logger.log(error);
	})
    }).catch(error => {
	Logger.log(error);
    });
}

async function doActionConflict(action) {
    // Take an action (see computeSyncActions) regarding conflicts

    // TODO: a dialog to let users choose what to do maybe?
}



// ---------
//
// COMMANDS:  Misc command fcns the user can initiate.
//
// ---------
async function commandExport() {
    let actions = await computeSyncActions();

    // Create all the directories.
    actions.filter(a => a.action==="mkdir").forEach(a => doActionMkdir(a));

    // Export files into the created directories
    actions.filter(a => a.action==="export").forEach(a => doActionExport(a));
}

async function commandImport() {
    let actions = await computeSyncActions();

    // Import all files we found that need an import.
    actions.filter(a => a.action==="import").forEach(a => doActionImport(a));
}
// ---------
//
// OLD COMMANDS:  Misc command fcns we want to obsolete.
//
// ---------

async function startImport() {
    await createJournalFolders(validMarkdownSourcePath()+validImportWorldPath(), null);
    let result = await FilePicker.browse(markdownPathOptions.activeSource, validMarkdownSourcePath()+validImportWorldPath());
    for (let [key, file] of Object.entries(result.files)) {
        if(isValidFile(file)) {
            await importFile(file);
        }
    }
    for (let [key, folder] of Object.entries(result.dirs)) {
        await importFolder(folder);
    }

    ui.notifications.info("Import completed");
    // FilePicker.browse(markdownPathOptions.activeSource, validMarkdownSourcePath()).then((result) => {
    //     console.log(result);
    //     result.files.forEach(file => {
    //         importFile(file);
    //     });
    //     result.dirs.forEach(folder => {
    //         importFolder(folder);
    //     });
    // });
}

async function startExport() {
    let journalFolders = await filemap.createJournalFolderTree();

    journalFolders.forEach(folderEntity => {
        createExportFolder(folderEntity, validMarkdownSourcePath()+validExportWorldPath());
    });

    // After creating all the files in subfolders, this bit saves all journal entries in the root
    // - ie - journals not in a subfolder.
    game.journal.filter(f => (f.data.folder === "")).forEach((value, key, map) => {
        Logger.logTrace(`m[${key}] = ${value.data.name} - ${value.data.folder} - ${value.data.type}`);
        exportJournal(value, validMarkdownSourcePath()+validExportWorldPath());
    });
    ui.notifications.info("Export completed");
}


// ---------
//
// UTILS
//
// ---------

function validGameName() {
    if (typeof game.world.name == "undefined") {
	// Version 8 of fvtt ?
	return game.world.data.name;
    } else {
	return game.world.name;
    }
}

function validMarkdownSourcePath() {
    let validMarkdownSourcePath = markdownSourcePath.replace("\\", "/");
    validMarkdownSourcePath += validMarkdownSourcePath.endsWith("/") ? "" : "/";
//  validMarkdownSourcePath += game.world.name + "/";
    return validMarkdownSourcePath;
}

function validImportWorldPath() {
    let validImportWorldPath = importWorldPath == "" ? (validGameName() + "/") : importWorldPath;
    validImportWorldPath += validImportWorldPath.endsWith("/") ? "" : "/";
    return validImportWorldPath;
}

function validExportWorldPath() {
    //console.log(game.world)
    let validExportWorldPath = exportWorldPath == "" ? (validGameName() + "/") : exportWorldPath;
    validExportWorldPath += validExportWorldPath.endsWith("/") ? "" : "/";
    return validExportWorldPath;
}

function isValidFile(filename) {
    return filename.endsWith('.md');
}

function isValidFileName(filename) {
    var re = /^(?!\.)(?!com[0-9]$)(?!con$)(?!lpt[0-9]$)(?!nul$)(?!prn$)[^\|\*\?\\:<>/$"]*[^\.\|\*\?\\:<>/$"]+$/
    return re.test(filename);
}

function generateJournalFileName(journalEntity) {
    return `${journalEntity.name} (${journalEntity.id}).md`
}

function getJournalIdFromFilename(fileName) {
    // 'sdfkjs dflksjd kljf skldjf(IDIDIDIID).md
    return last(fileName.split('(')).replace(').md', '');
}

function getJournalTitleFromFilename(fileName) {
    // 'sdfkjs dflksjd kljf skldjf(IDIDIDIID).md
    // Remove the ID if i is there and any .md remaining so it is just the file name with no extension.
    return fileName.replace(`(${getJournalIdFromFilename(fileName)}).md`, '').replace('.md', '');
}

function last(array) {
    return array[array.length - 1];
}

function hasJsonStructure(str) {
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

async function importFolder(importFolderPath) {
    Logger.logTrace(`Importing folder: ${importFolderPath}`);
    let result = await FilePicker.browse(markdownPathOptions.activeSource, importFolderPath);

    for (let [key, file] of Object.entries(result.files)) {
        if(isValidFile(file)) {
            await importFile(file);
        }
    }

    for (let [key, folder] of Object.entries(result.dirs)) {
        await importFolder(folder);
    }
}

// This will create the journal folder in FVTT
async function createJournalFolders(rootPath, parentFolderId) {
    Logger.logTrace(`createJournalFolders | Params(folder = ${rootPath} parent = ${parentFolderId})`)
    let result = await FilePicker.browse(markdownPathOptions.activeSource, rootPath)
    for (let [key, folder] of Object.entries(result.dirs)) {
        let thisFolderName = last(decodeURIComponent(folder).split('/'));
        let folderDetails = game.folders.filter(f => (f.data.type === "JournalEntry") && (f.data.name === thisFolderName) && (f.data.parent === parentFolderId));

        if (folderDetails.length == 0) {
            Logger.logTrace(`createJournalFolders | Creating folder path: ${thisFolderName} parent: ${parentFolderId}`)
            Logger.logTrace(`${JSON.stringify({ name: thisFolderName, type: "JournalEntry", parent: parentFolderId })}`);
            await Folder.create({ name: thisFolderName, type: "JournalEntry", parent: parentFolderId });
        }

        folderDetails = game.folders.filter(f => (f.data.type === "JournalEntry") && (f.data.name === thisFolderName) && (f.data.parent === parentFolderId));
        Logger.logTrace(`createJournalFolders | folder: ${folder} thisFolderName: ${thisFolderName} folderDetails.id: ${folderDetails[0].id} folderDetails: ${JSON.stringify(folderDetails)}`)

        createJournalFolders(folder, folderDetails[0].id);
    }
}

async function importFile(file) {
    Logger.logTrace(`importFile | params(file = ${file})`);
    var journalPath = decodeURIComponent(file).replace(validMarkdownSourcePath()+validImportWorldPath(), '').trim();
    var pathUrl = (journalPath.startsWith('https://') ? new URL(journalPath) : '')
    if(pathUrl) {
        var tempPathArray = pathUrl.pathname.split("/");
        journalPath = tempPathArray.slice(2).join("/").replace(/\%20/gi," ");
    }
    var journalId = getJournalIdFromFilename(journalPath).trim();
    var journalName = getJournalTitleFromFilename(last(journalPath.split('/'))).trim();
    var parentPath = journalPath.replace(last(journalPath.split('/')), '').trim();

    if (skippedJournalEntries.includes(journalName) || skippedJournalFolders.includes(last(journalPath.split('/')))) {
        return;
    }

    let currentParent = null;

    if (parentPath != '') {
        let pathArray = parentPath.split('/');
        for (let index = 0; index < pathArray.length; index++) {

            const path = pathArray[index];
            if (path != '') {
                let folder = game.folders.filter(f => (f.data.type === "JournalEntry") && (f.data.name === path) && (f.data.parent === currentParent));
                currentParent = folder[0].id;
                Logger.logTrace(`currentParent: '${currentParent}' path: '${path}' folder: '${JSON.stringify(folder)}' (${folder[0].id}) '${typeof folder}' '${folder.length}'`);
            }
        }
    }

    Logger.logTrace(`'${file}','${journalPath}','${journalId}','${journalName}','${parentPath}','${currentParent}'`);

    if(!pathUrl) file = '/' + file;
    fetch(file).then(response => {
        response.text().then(journalContents => {
            let updated = false;
            let md = "";

            // If the contents is pure JSON ignore it as it may be used by 
            // a module as configuration storage.
            if (hasJsonStructure(journalContents)) {
                md = journalContents
            } else {
                var converter = new showdown.Converter({ tables: true, strikethrough: true })
                md = converter.makeHtml(journalContents);
            }

            game.journal.filter(f => (f.id === journalId)).forEach((value, key, map) => {
                Logger.log(`Importing ${journalPath} with ID ${journalId} named ${journalName}`);
                value.update({ content: md });
                updated = true;
            });

            if (!updated) {
                Logger.log(`Creating ${journalPath} named ${journalName}`);
                JournalEntry.create({ name: journalName, content: md, folder: currentParent }).then(journal => { journal.show(); });
                ChatMessage.create({ content: `Added ${journalName}, please run export and delete '${journalName}.md'` });
            }

        });

    });
}

async function createExportFolder(folder, parentPath) {
    let folderPath = (parentPath + '/' + folder.data.name).replace("//", "/").trim();

    // Create folder directory on server. 
    // Try and create parent path before child, have to catch error 
    // as no way to check for folder existance that I saw.
    FilePicker.createDirectory(markdownPathOptions.activeSource, parentPath)
        .then((result) => {
            Logger.log(`Creating parent path ${parentPath}`);
        })
        .catch((error) => {
            if (!error.includes("EEXIST")) {
                Logger.log(error);
            } else {
                Logger.log(`Parent path ${parentPath} exists`);
            }
        });

    FilePicker.createDirectory(markdownPathOptions.activeSource, folderPath)
        .then((result) => {
            Logger.log(`Creating ${folderPath}`);
            folder.content.forEach(journalEntry => {
                exportJournal(journalEntry, folderPath);
            });
        })
        .catch((error) => {
            if (!error.includes("EEXIST")) {
                Logger.log(error);
            } else {
                Logger.log(`${folderPath} exists`);
                folder.content.forEach(journalEntry => {
                    exportJournal(journalEntry, folderPath);
                });
            }
        });


    // Recurse for any sub folders. 
    folder.children.forEach(folderEntity => {
        createExportFolder(folderEntity, folderPath);
    });
}

async function exportJournal(journalEntry, parentPath) {
    if (skippedJournalEntries.includes(journalEntry.name) || skippedJournalFolders.includes(last(parentPath.split('/')))) {
        Logger.log(`Skipping ${journalEntry.name} as it matches exclusion rules`)
        return;
    }

    if (! journalEntry.getFlag('journal-sync', 'ExportDirty')) {
        Logger.log(`Skipping ${journalEntry.name} because it is clean`);
	return;
    }

    
    if(!isValidFileName(journalEntry.name)) {
        ChatMessage.create({ content: `Unable to export:<br /> <strong>${parentPath}/${journalEntry.name}</strong><br />It has invalid character(s) in its name that can not be used in file names.<br /><br /> These characters are invalid: <pre>| * ? \ : < > $</pre><br />Please rename the Journal Entry and export again.` });
	return;
    }
    

    let md = "";
    let journalFileName = generateJournalFileName(journalEntry);

    // If the contents is pure JSON ignore it as it may be used by 
    // a module as configuration storage.
    if (hasJsonStructure(journalEntry.data.content)) {
        Logger.log(`Detected JSON, skipping markdown conversion for '${journalFileName}' located at '${parentPath}'`);
        md = journalEntry.data.content.split('\r\n');
    } else {
        var converter = new showdown.Converter({ tables: true, strikethrough: true });
        md = converter.makeMarkdown(journalEntry.data.content).split('\r\n');
    }

    let blob = new Blob([md], {type: "text/markdown"});
    let file = new File([blob], journalFileName, {type: "text/markdown"});

    // I'd like to get the last modified date of the file and compare to optimize
    // when to save, export, ore identify a conflict.  Not sure how to do that.
    //let lastMod = journalEntry.getFlag('journal-sync', 'LastSyncedTime');
    //Logger.log(`Compare Sync time: File: ${file.lastModified},  Journal Last Sync: ${lastMod}`);
    
    FilePicker.upload(markdownPathOptions.activeSource, parentPath, file, { bucket: null })
        .then((result) => {
            Logger.log(`Uploading ${parentPath}/${journalFileName}`);
        })
        .catch((error) => {
            Logger.log(error);
        });

    // Mark as clean (doesn't need to save anymore)
    setJournalSyncDirty(journalEntry, false);
}

async function createFolderTree(dataset) {
    let hashTable = Object.create(null);
    let dataTree = [];
    dataset.forEach(folderEntity => hashTable[folderEntity.id] = {
	data : folderEntity.data,
	content : folderEntity.content,
	children : folderEntity.children,
	childNodes : [] });

    dataset.forEach(folderEntity => {
	if (folderEntity.data.parent) {
            hashTable[folderEntity.data.parent].childNodes.push(hashTable[folderEntity.id]);
        } else {
            dataTree.push(hashTable[folderEntity.id]);
        }
    })
    return dataTree;
}


