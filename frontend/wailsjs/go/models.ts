export namespace domain {



	export class ConnectionRef {
	    tabId: string;
	    sessionId: string;
	    generation: number;

	    static createFrom(source: any = {}) {
	        return new ConnectionRef(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.tabId = source["tabId"];
	        this.sessionId = source["sessionId"];
	        this.generation = source["generation"];
	    }
	}






	export class Group {
	    id: string;
	    name: string;

	    static createFrom(source: any = {}) {
	        return new Group(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	    }
	}

	export class Session {
	    id: string;
	    groupId: string;
	    name: string;
	    host: string;
	    port: number;
	    username: string;
	    authType: string;
	    privateKeyPath: string;
	    credentialRef: string;
	    createdAt: string;
	    updatedAt: string;

	    static createFrom(source: any = {}) {
	        return new Session(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.groupId = source["groupId"];
	        this.name = source["name"];
	        this.host = source["host"];
	        this.port = source["port"];
	        this.username = source["username"];
	        this.authType = source["authType"];
	        this.privateKeyPath = source["privateKeyPath"];
	        this.credentialRef = source["credentialRef"];
	        this.createdAt = source["createdAt"];
	        this.updatedAt = source["updatedAt"];
	    }
	}

}

export namespace main {

	export class QuickCommand {
	    id: string;
	    name: string;
	    command: string;
	    category: string;
	    scope: string;
	    scopeId: string;
	    mode: string;
	    confirm: boolean;

	    static createFrom(source: any = {}) {
	        return new QuickCommand(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.command = source["command"];
	        this.category = source["category"];
	        this.scope = source["scope"];
	        this.scopeId = source["scopeId"];
	        this.mode = source["mode"];
	        this.confirm = source["confirm"];
	    }
	}
	export class AppState {

	    language: string;
	    sessions: domain.Session[];
	    groups: domain.Group[];

	    quickCommands: QuickCommand[];
	    quickCommandLayout: string;
	    autoCopySelection: boolean;
	    rightClickPaste: boolean;
	    confirmMultilinePaste: boolean;
	    fontSize: string;
	    theme: string;

	    version: string;

	    static createFrom(source: any = {}) {
	        return new AppState(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);

	        this.language = source["language"];
	        this.sessions = this.convertValues(source["sessions"], domain.Session);
	        this.groups = this.convertValues(source["groups"], domain.Group);

	        this.quickCommands = this.convertValues(source["quickCommands"], QuickCommand);
	        this.quickCommandLayout = source["quickCommandLayout"];
	        this.autoCopySelection = source["autoCopySelection"];
	        this.rightClickPaste = source["rightClickPaste"];
	        this.confirmMultilinePaste = source["confirmMultilinePaste"];
	        this.fontSize = source["fontSize"];
	        this.theme = source["theme"];

	        this.version = source["version"];
	    }

		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}


	export class HostChallenge {
	    id: string;
	    address: string;
	    fingerprint: string;
	    changed: boolean;

	    static createFrom(source: any = {}) {
	        return new HostChallenge(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.address = source["address"];
	        this.fingerprint = source["fingerprint"];
	        this.changed = source["changed"];
	    }
	}
	export class ConnectResult {
	    ref: domain.ConnectionRef;
	    challenge?: HostChallenge;
	    home: string;

	    static createFrom(source: any = {}) {
	        return new ConnectResult(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.ref = this.convertValues(source["ref"], domain.ConnectionRef);
	        this.challenge = this.convertValues(source["challenge"], HostChallenge);
	        this.home = source["home"];
	    }

		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}



	export class SaveSessionRequest {
	    session: domain.Session;
	    secret: string;
	    saveSecret: boolean;

	    static createFrom(source: any = {}) {
	        return new SaveSessionRequest(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.session = this.convertValues(source["session"], domain.Session);
	        this.secret = source["secret"];
	        this.saveSecret = source["saveSecret"];
	    }

		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

