package sshclient

import (
	"errors"
	"strings"
)

// The SQL checks below are a defence in depth for AI-issued queries in an
// already authenticated MySQL or psql client. Server-side grants remain the
// real security boundary; use a read-only database account for AI work.
//
// Queries are tokenized so semicolons, comment markers or keywords inside
// string literals and quoted identifiers are treated as data, while the same
// characters outside quotes are rejected or checked.

type sqlTokenKind int

const (
	sqlWord sqlTokenKind = iota
	sqlQuotedIdent
	sqlString
	sqlNumber
	sqlPunct
)

type sqlToken struct {
	kind sqlTokenKind
	text string
}

var errSQLComment = errors.New("comments are not supported in AI queries")

func tokenizeSQL(query, dialect string) ([]sqlToken, error) {
	var tokens []sqlToken
	mysql := dialect == "mysql"
	for i := 0; i < len(query); {
		c := query[i]
		switch {
		case c == ' ' || c == '\t' || c == '\n':
			i++
		case c == '-' && i+1 < len(query) && query[i+1] == '-':
			return nil, errSQLComment
		case c == '/' && i+1 < len(query) && query[i+1] == '*':
			return nil, errSQLComment
		case c == '#' && mysql:
			return nil, errSQLComment
		case c == '\\':
			// Backslash commands and escapes are interpreted differently by
			// clients and server modes, so they are never accepted.
			return nil, errors.New("backslashes are not supported in AI queries")
		case c == '\'' || (c == '"' && mysql):
			end, err := sqlQuoteEnd(query, i, c)
			if err != nil {
				return nil, err
			}
			tokens = append(tokens, sqlToken{sqlString, query[i+1 : end]})
			i = end + 1
		case c == '"' || (c == '`' && mysql):
			end, err := sqlQuoteEnd(query, i, c)
			if err != nil {
				return nil, err
			}
			tokens = append(tokens, sqlToken{sqlQuotedIdent, strings.ReplaceAll(query[i+1:end], string([]byte{c, c}), string(c))})
			i = end + 1
		case c == '$' && !mysql:
			// PostgreSQL dollar quoting: $tag$ ... $tag$
			j := i + 1
			for j < len(query) && query[j] != '$' && isSQLIdentByte(query[j]) {
				j++
			}
			if j < len(query) && query[j] == '$' {
				tag := query[i : j+1]
				end := strings.Index(query[j+1:], tag)
				if end < 0 {
					return nil, errors.New("unterminated dollar-quoted string")
				}
				tokens = append(tokens, sqlToken{sqlString, query[j+1 : j+1+end]})
				i = j + 1 + end + len(tag)
				continue
			}
			// $1 positional parameter
			tokens = append(tokens, sqlToken{sqlPunct, "$"})
			i++
		case isSQLIdentStart(c):
			j := i
			for j < len(query) && isSQLIdentByte(query[j]) {
				j++
			}
			tokens = append(tokens, sqlToken{sqlWord, strings.ToUpper(query[i:j])})
			i = j
		case c >= '0' && c <= '9':
			j := i
			for j < len(query) && (isSQLIdentByte(query[j]) || query[j] == '.') {
				j++
			}
			tokens = append(tokens, sqlToken{sqlNumber, query[i:j]})
			i = j
		case c == ':' && i+1 < len(query) && query[i+1] == '=':
			tokens = append(tokens, sqlToken{sqlPunct, ":="})
			i += 2
		default:
			tokens = append(tokens, sqlToken{sqlPunct, string(c)})
			i++
		}
	}
	return tokens, nil
}

func sqlQuoteEnd(query string, start int, quote byte) (int, error) {
	for j := start + 1; j < len(query); j++ {
		if query[j] == '\\' {
			return 0, errors.New("backslashes are not supported in AI queries")
		}
		if query[j] == quote {
			if j+1 < len(query) && query[j+1] == quote {
				j++
				continue
			}
			return j, nil
		}
	}
	return 0, errors.New("unterminated quoted string")
}

func isSQLIdentStart(c byte) bool {
	return c == '_' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= 0x80
}

func isSQLIdentByte(c byte) bool { return isSQLIdentStart(c) || c >= '0' && c <= '9' || c == '$' }

var mysqlBlockedFunctions = map[string]bool{
	"SLEEP": true, "BENCHMARK": true, "GET_LOCK": true, "RELEASE_LOCK": true, "RELEASE_ALL_LOCKS": true,
	"LOAD_FILE": true, "MASTER_POS_WAIT": true, "SOURCE_POS_WAIT": true, "WAIT_FOR_EXECUTED_GTID_SET": true,
	"WAIT_UNTIL_SQL_THREAD_AFTER_GTIDS": true, "SYS_EXEC": true, "SYS_EVAL": true, "SYS_GET": true, "SYS_SET": true,
	"NEXTVAL": true, "SETVAL": true, "LASTVAL": false,
}

var psqlAllowedPgFunctions = map[string]bool{
	"PG_SIZE_PRETTY": true, "PG_RELATION_SIZE": true, "PG_TOTAL_RELATION_SIZE": true, "PG_TABLE_SIZE": true,
	"PG_INDEXES_SIZE": true, "PG_DATABASE_SIZE": true, "PG_TABLESPACE_SIZE": true, "PG_COLUMN_SIZE": true,
	"PG_TYPEOF": true, "PG_BACKEND_PID": true, "PG_POSTMASTER_START_TIME": true, "PG_CONF_LOAD_TIME": true,
	"PG_IS_IN_RECOVERY": true, "PG_LAST_WAL_RECEIVE_LSN": true, "PG_LAST_WAL_REPLAY_LSN": true,
	"PG_LAST_XACT_REPLAY_TIMESTAMP": true, "PG_CURRENT_WAL_LSN": true, "PG_WAL_LSN_DIFF": true,
	"PG_BLOCKING_PIDS": true, "PG_TABLE_IS_VISIBLE": true, "PG_FUNCTION_IS_VISIBLE": true, "PG_HAS_ROLE": true,
	"PG_ENCODING_TO_CHAR": true, "PG_CLIENT_ENCODING": true, "PG_TABLESPACE_LOCATION": true,
	"PG_RELATION_FILEPATH": true, "PG_SIZE_BYTES": true, "PG_JIT_AVAILABLE": true, "PG_XACT_COMMIT_TIMESTAMP": true,
}

var psqlBlockedFunctions = map[string]bool{
	"SET_CONFIG": true, "NEXTVAL": true, "SETVAL": true, "QUERY_TO_XML": true, "QUERY_TO_XMLSCHEMA": true,
	"QUERY_TO_XML_AND_XMLSCHEMA": true, "CURSOR_TO_XML": true, "CURSOR_TO_XMLSCHEMA": true, "TXID_CURRENT": true,
	"CURRENT_SETTING": false,
}

func sqlFunctionBlocked(name, dialect string) bool {
	if dialect == "mysql" {
		return mysqlBlockedFunctions[name]
	}
	if psqlBlockedFunctions[name] || strings.HasPrefix(name, "LO_") || strings.HasPrefix(name, "DBLINK") {
		return true
	}
	if strings.HasPrefix(name, "PG_") {
		return !psqlAllowedPgFunctions[name] && !strings.HasPrefix(name, "PG_GET_") && !strings.HasPrefix(name, "PG_STAT_GET_")
	}
	return false
}

// validateReadOnlySQL checks a single statement (without the trailing
// terminator) against an allowlist of leading keywords and blocks clauses or
// functions that write, lock, sleep or touch the server filesystem.
func validateReadOnlySQL(query, dialect string, allowed map[string]bool) error {
	tokens, err := tokenizeSQL(query, dialect)
	if err != nil {
		return err
	}
	if len(tokens) == 0 || tokens[0].kind != sqlWord || !allowed[tokens[0].text] {
		return errors.New("only read-only statements are allowed")
	}
	for i, tok := range tokens {
		if tok.kind == sqlPunct && tok.text == ";" {
			return errors.New("only one statement is allowed")
		}
		if tok.kind == sqlPunct && tok.text == ":=" {
			return errors.New("variable assignment is not allowed")
		}
		if tok.kind == sqlWord {
			switch tok.text {
			case "INTO", "LOCK", "ANALYZE", "ANALYSE", "OUTFILE", "DUMPFILE":
				return errors.New("the statement contains a write, lock or execute clause")
			case "FOR":
				if i+1 < len(tokens) && tokens[i+1].kind == sqlWord {
					switch tokens[i+1].text {
					case "UPDATE", "SHARE", "NO", "KEY":
						return errors.New("locking reads are not allowed")
					}
				}
			}
		}
		if (tok.kind == sqlWord || tok.kind == sqlQuotedIdent) && i+1 < len(tokens) &&
			tokens[i+1].kind == sqlPunct && tokens[i+1].text == "(" {
			name := strings.ToUpper(tok.text)
			if sqlFunctionBlocked(name, dialect) {
				return errors.New("the function " + strings.ToLower(name) + " is not allowed")
			}
		}
	}
	return nil
}
