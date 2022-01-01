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
    	    invokeOnCommand: chatCommandFcn,    
    	    shouldDisplayToChat: false,
    	    iconClass: "fa-sticky-note",
    	    description: "Synchronize Journals for external editors",
    	    gmOnly: true
    	}));
    });
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

    //Hooks.on("getSceneControlButtons", (controls) => {
    //    let group = controls.find(function(b) {
    //	    return b.name == "notes" });
    //    group.tools.push({
    //        name: "import",
    //        title: "Import Journals",
    //        icon: "fas fa-file-import",
    //        onClick: () => {
    //            commandImport();
    //        },
    //        button: true
    //    });
    //    group.tools.push({
    //        name: "export",
    //        title: "Export Journals",
    //        icon: "fas fa-file-export",
    //        onClick: () => {
    //            commandExport();
    //        },
    //        button: true,
    //    });
    //
    //    if (journalEditorLink != "") {
    //        group.tools.push({
    //            name: "edit",
    //            title: "Edit Journals",
    //            icon: "fas fa-edit",
    //            onClick: () => {
    //                window.open(journalEditorLink, "_blank");
    //            },
    //            button: true,
    //        });
    //    }
    //});

    // Initialize tracking journal edits so we can auto-sync
    Hooks.on("updateJournalEntry", journalModifiedHookFcn);
}

async function chatCommandFcn (chatlog, messageText, chatdata) {
    switch (messageText) {
    case "help":
	return "This is a help string";
	
    case "test": // /js test
	let dir = validMarkdownSourcePath()+validImportWorldPath();
	Logger.log('Starting TEST sequence at ' + dir);

	let fmap = await FileMap.scanDirectoryTree(markdownPathOptions, dir);
	Logger.log("File Map");
	Logger.log(fmap);

	let jmap = await FileMap.scanJournalTree();
	Logger.log("Journal Map");
	Logger.log(jmap);

	let mmap = FileMap. mergeJournalAndFileTrees(fmap, jmap);
	
	//let mmap = await FileMap.computeTreeForJournals(markdownPathOptions, dir);
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

    case "sync":
	commandSync();
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
}

// ---------
//
// SIDEBAR & DIALOGS:  UI in the sidebar, and resulting dialog boxes
//
// ---------
export function initSidebar(app, html) {
    if (app.options.id == "journal") {
	let button = $("<button class='journal-sync'><i class='fas fa-file-export'></i>Import & Export Journal Files</button>")
	
	button.click(function () {
            //commandSync();
	    dialogSync();
	});
	
	html.find(".directory-footer").append(button);
    }
}

async function dialogSync() {
    let actions = await computeSyncActions();

    if (actions.length == 0) {
	let d = new Dialog({
	    title: "Journal-Sync",
	    content: "<h2>Synchronize Journals to Disk</h2>Actions Needed: None",
	    buttons: {
		cancel: {
		    icon: '<i class="fas fa-times"></i>',
		    label: "Cancel",
		    callback: () => {}
		}
	    },
	    default: "cancel",
	    render: html => {}, //Logger.log("Register interactivity in the rendered dialog"),
	    close: html => {} //Logger.log("This always is logged no matter which option is chosen")	
	});

	d.render(true);

	return;
    }

    // We have some content - show a more complex dialog box.
    let d = new Dialog({
	title: "Journal-Sync",
	content: "<h2>Synchronize Journals to Disk</h2>Actions Needed: " +
	    "<ol>" + actions.map(a=>"<li>" + a.action +
				 " \"" + a.what.name +
				 "\" " + a.where).join('')
	    + "</ol>",
	buttons: {
	    sync: {
		icon: '<i class="fas fa-file-export"></i>',
		label: "Sync!",
		callback: commandSync
	    },
	    //export: {
	    //	icon: '<i class="fas fa-file-export"></i>',
	    //	label: "Export Only",
	    //	callback: commandExport
	    //},
	    //import: {
	    //	icon: '<i class="fas fa-file-import"></i>',
	    //	label: "Import Only",
	    //	callback: commandImport
	    //},
	    cancel: {
		icon: '<i class="fas fa-times"></i>',
		label: "Cancel",
		callback: () => {}
	    }
	},
	default: "sync",
	render: html => {}, //Logger.log("Register interactivity in the rendered dialog"),
	close: html => {} //Logger.log("This always is logged no matter which option is chosen")	
    });

    d.render(true);
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

    let fcn = function (lmmap, pathaccum, prevfolder, depth) {
	let path = pathaccum + "/" + lmmap.file;
	let jfolder = lmmap.journal;
	let fact = undefined;
	
	// Step 1.1: Do we need to make this directory?
	if (!lmmap.ondisk) {
	    // If it doesn't exist on disk, then .file is undefined.
	    // Derive from the name.
	    path = pathaccum + "/" + lmmap.name;
	    actions.push({ action: "mkdir",
			   what: lmmap,
			   where: path,
			   jwhere: jfolder,
			   depth: depth});
	}
	// Step 1.2: Do we need to make a journal folder ?
	if (!jfolder && lmmap != mmap) {
	    // If it doesn't exist on disk, then .file is undefined.
	    // Derive from the name.
	    actions.push({ action: "mkfolder",
			   what: lmmap,
			   where: path,
			   jwhere: prevfolder,
			   depth: depth });
	}
	

	// Step 2: Loop over all the files
	for (let idx=0; idx < lmmap.files.length; idx++) {
	    let f = lmmap.files[idx];
	    if (typeof f === "undefined") {
		Logger.log(`Undefined file found in ${lmmap.name}`);
	    }
	    // Step 2.1: Save merge conflicts.
	    if (f.merge_conflict) {
		actions.push({ action: "conflict",
			       what: f,
			       where: path,
			       jwhere: jfolder,
			       depth: depth });
	    } else {
		// Step 2.2: Save exports
		if (f.save_needed) {
		    actions.push({ action: "export",
				   what: f,
				   where: path,
				   jwhere: jfolder,
				   depth: depth });

		    
		} else
		    // Step 2.3: Save imports
		    if (f.import_needed) {
			actions.push({ action: "import",
				       what: f,
				       where: path,
				       jwhere: jfolder,
				       depth: depth });
		    } else {
			//Logger.log(`No Action needed on ${f.name}`);
		    }
	    }
	}

	// Step 3: Loop over subdirs and recurse
	for (let idx=0; idx < lmmap.subdir.length; idx++) {
	    fcn(lmmap.subdir[idx], path, jfolder, depth+1);
	}
    };
    
    fcn(mmap,"",undefined, 0);
    
    return actions;
}

// ---------
//
// DO ACTIONS:  Functions that will do needed actions of specific types.
//
// ---------
function actionPath(action) {
    let fullpath = (validMarkdownSourcePath()+action.where).replace("//", "/").trim();
    //Logger.log(`Action Path: ${fullpath}`);
    return fullpath;
};

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

function findJFolderFromDirname(dirname,back=0) {
    // Find a JournalEntry Folder derived from the pathname DIRNAME.
    // Optional input BACK by default takes the last entry in DIRNAME (0)
    // if you specify 1, then find parent based on next-to-last entry.
    let path = dirname.split("/");
    let targetname = path[path.length-back-1];
    let parent = game.folders.filter(f => (f.data.type === "JournalEntry") && (f.data.name === targetname));

    if (parent.length !== 1) {
	// Too bad - not sure what happend.
	Logger.log(`Parent search fialed at "${targetname}"`);
	return;
    }
    
    //Logger.log(parent)
    return parent[0];
}

async function doActionMkFolder(action) {
    if (action.depth === 1) {
	// At depth 1, jwhere will be empty, so just go with null for parent folder.
	Logger.log(`Create root folder: ${action.what.name}`);
	let F = await Folder.create({name: action.what.name, type: "JournalEntry", parent: "" });
    } else if (action.depth >= 2) {
	// At depth 2 or more the jwhere field should not be undefined.  If it is, then hopefully
	// a previous action created the parent journal.  Go find it.  If not, skip.
	let parent = action.jwhere;
	if (typeof parent === "undefined") {
	    Logger.log(`Create sub folder with no parent: ${action.what.name}`);
	    parent = findJFolderFromDirname(action.where,1);
	    if (typeof parent === "undefined") {
		Logger.log(`No parent found - bail on this make, try again`);
		return
	    }
	}
	// jwhere is set - just do it.
	Logger.log(`Create sub folder: ${action.what.name} under ${parent.data.name}`);
	let F = await Folder.create({name: action.what.name, type: "JournalEntry", parent: parent.data._id });
    }
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
		let parentfolder = action.jwhere;
		
		if (action.depth >= 1 && typeof parentfolder === "undefined") {
		    // No journal but high depth means the folder wasn't available during action creation.
		    // Search for a parent now.
		    // Logger.log(`To create ${action.what.name} parent was undefined.  Checking via dirname`);
		    parentfolder = findJFolderFromDirname(action.where);
		    if (typeof parent === "undefined") {
			Logger.log(`No parent for journal ${action.what.name} found - bail on this import, try again`);
			return
		    }
		}
		
		JournalEntry.create({ name: action.what.name, content: md, folder: parentfolder.data._id,
				      flags: { 'journal-sync': { ExportDirty: false,
								 LastModified: Date.now() }}});
		
	    } else {
		journal.update({contents: md}); // This doesn't call our hook?
		setJournalSyncDirty(journal, false, true);// Set not dirty, but also set modified hook.
	    }
	    //Logger.log(`doAction: import: Async import done for ${fname}`);
	    
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
    for (const a of actions.filter(a => a.action==="mkdir")) {
	await doActionMkdir(a);
    }

    // Export files into the created directories
    actions.filter(a => a.action==="export").forEach(a => doActionExport(a));

    ui.notifications.info("Export completed");
}

async function commandImport() {
    let actions = await computeSyncActions();
    
    // Create all the journal folders.
    for (const a of actions.filter(a => a.action==="mkfolder")) {
	fold++;
	await doActionMkFolder(a);
    }

    // Import all files we found that need an import.
    actions.filter(a => a.action==="import").forEach(a => doActionImport(a));

    ui.notifications.info("Import completed");
}

async function commandSync() {
    let actions = await computeSyncActions();
    let dir = 0, fold=0, ex = 0, im = 0, con = 0;

    // Create all the journal folders.
    for (const a of actions.filter(a => a.action==="mkfolder")) {
	fold++;
	await doActionMkFolder(a);
    }

    // Create all the directories.
    for (const a of actions.filter(a => a.action==="mkdir")) {
	dir++;
	await doActionMkdir(a);
    }

    // Export files into the created directories
    actions.filter(a => a.action==="export").forEach(a => {ex++; doActionExport(a)});

    // Import all files we found that need an import.
    actions.filter(a => a.action==="import").forEach(a => {im++; doActionImport(a)});

    ui.notifications.info(`Sync Complete:  Directory Creation (${dir}) Export (${ex}) Folder Create (${fold}) Import (${im})`);
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
    //Logger.log(game.world)
    let validExportWorldPath = exportWorldPath == "" ? (validGameName() + "/") : exportWorldPath;
    validExportWorldPath += validExportWorldPath.endsWith("/") ? "" : "/";
    return validExportWorldPath;
}

function isValidFileName(filename) {
    var re = /^(?!\.)(?!com[0-9]$)(?!con$)(?!lpt[0-9]$)(?!nul$)(?!prn$)[^\|\*\?\\:<>/$"]*[^\.\|\*\?\\:<>/$"]+$/
    return re.test(filename);
}

function generateJournalFileName(journalEntity) {
    return `${journalEntity.name} (${journalEntity.id}).md`
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



