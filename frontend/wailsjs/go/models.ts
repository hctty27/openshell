export namespace ai {

	export class Preview {
	    text: string;
	    truncated: boolean;

	    static createFrom(source: any = {}) {
	        return new Preview(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.text = source["text"];
	        this.truncated = source["truncated"];
	    }
	}

}

export namespace domain {

	export class APIProfile {
	    id: string;
	    name: string;
	    baseUrl: string;
	    model: string;
	    secretRef: string;
	    toolsEnabled: boolean;

	    static createFrom(source: any = {}) {
	        return new APIProfile(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.baseUrl = source["baseUrl"];
	        this.model = source["model"];
	        this.secretRef = source["secretRef"];
	        this.toolsEnabled = source["toolsEnabled"];
	    }
	}
	export class CommandResult {
	    reasonCode?: string;
	    reasonParams?: Record<string, any>;
	    status: string;
	    stdout: string;
	    stderr: string;
	    exitCode?: number;
	    durationMillis: number;
	    truncated: boolean;
	    reason: string;

	    static createFrom(source: any = {}) {
	        return new CommandResult(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.reasonCode = source["reasonCode"];
	        this.reasonParams = source["reasonParams"];
	        this.status = source["status"];
	        this.stdout = source["stdout"];
	        this.stderr = source["stderr"];
	        this.exitCode = source["exitCode"];
	        this.durationMillis = source["durationMillis"];
	        this.truncated = source["truncated"];
	        this.reason = source["reason"];
	    }
	}
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
	export class Conversation {
	    id: string;
	    serverKey: string;
	    sessionId: string;
	    title: string;
	    titleManual: boolean;
	    summary: string;
	    summaryThroughSeq: number;
	    revision: number;
	    createdAt: string;
	    updatedAt: string;

	    static createFrom(source: any = {}) {
	        return new Conversation(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.serverKey = source["serverKey"];
	        this.sessionId = source["sessionId"];
	        this.title = source["title"];
	        this.titleManual = source["titleManual"];
	        this.summary = source["summary"];
	        this.summaryThroughSeq = source["summaryThroughSeq"];
	        this.revision = source["revision"];
	        this.createdAt = source["createdAt"];
	        this.updatedAt = source["updatedAt"];
	    }
	}
	export class ConversationCursor {
	    updatedAt: string;
	    id: string;

	    static createFrom(source: any = {}) {
	        return new ConversationCursor(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.updatedAt = source["updatedAt"];
	        this.id = source["id"];
	    }
	}
	export class ConversationList {
	    items: Conversation[];
	    nextCursor?: ConversationCursor;

	    static createFrom(source: any = {}) {
	        return new ConversationList(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.items = this.convertValues(source["items"], Conversation);
	        this.nextCursor = this.convertValues(source["nextCursor"], ConversationCursor);
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
	export class ConversationMessage {
	    id: string;
	    conversationId: string;
	    seq: number;
	    role: string;
	    content: string;
	    toolCalls?: number[];
	    toolCallId?: string;
	    display?: number[];
	    status: string;
	    createdAt: string;

	    static createFrom(source: any = {}) {
	        return new ConversationMessage(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.conversationId = source["conversationId"];
	        this.seq = source["seq"];
	        this.role = source["role"];
	        this.content = source["content"];
	        this.toolCalls = source["toolCalls"];
	        this.toolCallId = source["toolCallId"];
	        this.display = source["display"];
	        this.status = source["status"];
	        this.createdAt = source["createdAt"];
	    }
	}
	export class ConversationRun {
	    id: string;
	    conversationId: string;
	    kind: string;
	    status: string;
	    ownerRef: ConnectionRef;

	    static createFrom(source: any = {}) {
	        return new ConversationRun(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.conversationId = source["conversationId"];
	        this.kind = source["kind"];
	        this.status = source["status"];
	        this.ownerRef = this.convertValues(source["ownerRef"], ConnectionRef);
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
	export class ConversationPage {
	    conversation: Conversation;
	    messages: ConversationMessage[];
	    beforeSeq: number;
	    hasMore: boolean;
	    run?: ConversationRun;
	    eventSeq: number;

	    static createFrom(source: any = {}) {
	        return new ConversationPage(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.conversation = this.convertValues(source["conversation"], Conversation);
	        this.messages = this.convertValues(source["messages"], ConversationMessage);
	        this.beforeSeq = source["beforeSeq"];
	        this.hasMore = source["hasMore"];
	        this.run = this.convertValues(source["run"], ConversationRun);
	        this.eventSeq = source["eventSeq"];
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
	export class Proposal {
	    id: string;
	    ref: ConnectionRef;
	    command: string;
	    purpose: string;
	    cwd: string;
	    timeoutSeconds: number;
	    status: string;
	    toolCallId: string;

	    static createFrom(source: any = {}) {
	        return new Proposal(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.ref = this.convertValues(source["ref"], ConnectionRef);
	        this.command = source["command"];
	        this.purpose = source["purpose"];
	        this.cwd = source["cwd"];
	        this.timeoutSeconds = source["timeoutSeconds"];
	        this.status = source["status"];
	        this.toolCallId = source["toolCallId"];
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
	    saveChatHistory: boolean;
	    autoSummarize: boolean;
	    language: string;
	    sessions: domain.Session[];
	    groups: domain.Group[];
	    profiles: domain.APIProfile[];
	    quickCommands: QuickCommand[];
	    quickCommandLayout: string;
	    autoCopySelection: boolean;
	    rightClickPaste: boolean;
	    confirmMultilinePaste: boolean;
	    fontSize: string;
	    theme: string;
	    activeProfile: string;
	    autoCommandLimit: number;
	    autoAllowChanges: boolean;
	    version: string;

	    static createFrom(source: any = {}) {
	        return new AppState(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.saveChatHistory = source["saveChatHistory"];
	        this.autoSummarize = source["autoSummarize"];
	        this.language = source["language"];
	        this.sessions = this.convertValues(source["sessions"], domain.Session);
	        this.groups = this.convertValues(source["groups"], domain.Group);
	        this.profiles = this.convertValues(source["profiles"], domain.APIProfile);
	        this.quickCommands = this.convertValues(source["quickCommands"], QuickCommand);
	        this.quickCommandLayout = source["quickCommandLayout"];
	        this.autoCopySelection = source["autoCopySelection"];
	        this.rightClickPaste = source["rightClickPaste"];
	        this.confirmMultilinePaste = source["confirmMultilinePaste"];
	        this.fontSize = source["fontSize"];
	        this.theme = source["theme"];
	        this.activeProfile = source["activeProfile"];
	        this.autoCommandLimit = source["autoCommandLimit"];
	        this.autoAllowChanges = source["autoAllowChanges"];
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
	export class ChatRequest {
	    requestId: string;
	    ref: domain.ConnectionRef;
	    profileId: string;
	    text: string;
	    context: string;
	    operate: boolean;

	    static createFrom(source: any = {}) {
	        return new ChatRequest(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.requestId = source["requestId"];
	        this.ref = this.convertValues(source["ref"], domain.ConnectionRef);
	        this.profileId = source["profileId"];
	        this.text = source["text"];
	        this.context = source["context"];
	        this.operate = source["operate"];
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
	export class ChatResponse {
	    text: string;
	    proposal?: domain.Proposal;

	    static createFrom(source: any = {}) {
	        return new ChatResponse(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.text = source["text"];
	        this.proposal = this.convertValues(source["proposal"], domain.Proposal);
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
	    conversationId: string;
	    ref: domain.ConnectionRef;
	    challenge?: HostChallenge;
	    home: string;

	    static createFrom(source: any = {}) {
	        return new ConnectResult(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.conversationId = source["conversationId"];
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


	export class SaveAPIRequest {
	    profile: domain.APIProfile;
	    key: string;
	    memoryOnly: boolean;

	    static createFrom(source: any = {}) {
	        return new SaveAPIRequest(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.profile = this.convertValues(source["profile"], domain.APIProfile);
	        this.key = source["key"];
	        this.memoryOnly = source["memoryOnly"];
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

export namespace tasks {

	export class AutoSnapshot {
	    reasonCode?: string;
	    reasonParams?: Record<string, any>;
	    id: string;
	    ref: domain.ConnectionRef;
	    status: string;
	    steps: number;
	    roundSteps: number;
	    limit: number;
	    allowChanges: boolean;
	    reason: string;
	    proposal?: domain.Proposal;

	    static createFrom(source: any = {}) {
	        return new AutoSnapshot(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.reasonCode = source["reasonCode"];
	        this.reasonParams = source["reasonParams"];
	        this.id = source["id"];
	        this.ref = this.convertValues(source["ref"], domain.ConnectionRef);
	        this.status = source["status"];
	        this.steps = source["steps"];
	        this.roundSteps = source["roundSteps"];
	        this.limit = source["limit"];
	        this.allowChanges = source["allowChanges"];
	        this.reason = source["reason"];
	        this.proposal = this.convertValues(source["proposal"], domain.Proposal);
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

