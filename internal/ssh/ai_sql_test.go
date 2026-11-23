package sshclient

import "testing"

func TestMySQLReadOnlyQueryTokenizer(t *testing.T) {
	allowed := []string{
		"SELECT * FROM t WHERE a='x;y'",
		"SELECT * FROM t WHERE note = 'a -- b # c /* d */'",
		"SELECT `select`, \"semi;colon\" FROM `t;x`",
		"SHOW CREATE TABLE t_user",
		"SHOW CHARACTER SET",
		"SELECT REPLACE(name, 'a', 'b') FROM t;",
		"SELECT 'it''s'\\G",
		"EXPLAIN SELECT * FROM t WHERE id = 1",
	}
	for _, q := range allowed {
		if _, err := mysqlReadOnlyQuery(q); err != nil {
			t.Errorf("valid query rejected: %q: %v", q, err)
		}
	}
	blocked := []string{
		"SELECT SLEEP(10)",
		"SELECT sleep (10)",
		"SELECT `sleep`(10)",
		"SELECT BENCHMARK(1000000, MD5('a'))",
		"SELECT GET_LOCK('x', 10)",
		"SELECT LOAD_FILE('/etc/passwd')",
		"SELECT * FROM t INTO OUTFILE '/tmp/x'",
		"SELECT * FROM t FOR UPDATE",
		"SELECT * FROM t LOCK IN SHARE MODE",
		"SELECT 1; DROP TABLE t",
		"SELECT 1 -- comment",
		"SELECT 1 # comment",
		"SELECT /*! SLEEP(1) */ 1",
		"SELECT 'a\\'; DROP TABLE t; -- '",
		"SELECT @x := 1",
		"EXPLAIN ANALYZE SELECT 1",
		"DELETE FROM t",
		"SELECT 'unterminated",
	}
	for _, q := range blocked {
		if _, err := mysqlReadOnlyQuery(q); err == nil {
			t.Errorf("unsafe query accepted: %q", q)
		}
	}
}

func TestPsqlReadOnlyQueryTokenizer(t *testing.T) {
	allowed := []string{
		"SELECT * FROM t WHERE a='x;y'",
		"SELECT pg_size_pretty(pg_database_size(current_database()))",
		"SELECT pg_get_viewdef('v'::regclass)",
		"SELECT * FROM pg_stat_activity",
		"SELECT $$a;b$$",
		"SHOW search_path;",
		"TABLE users",
	}
	for _, q := range allowed {
		if _, err := psqlAICommand(q); err != nil {
			t.Errorf("valid query rejected: %q: %v", q, err)
		}
	}
	blocked := []string{
		"SELECT pg_sleep(10)",
		"SELECT pg_catalog.pg_sleep(10)",
		"SELECT \"pg_sleep\"(10)",
		"SELECT pg_read_file('/etc/passwd')",
		"SELECT pg_read_binary_file('/etc/passwd')",
		"SELECT pg_ls_dir('/')",
		"SELECT lo_import('/etc/passwd')",
		"SELECT set_config('default_transaction_read_only','off',false)",
		"SELECT nextval('s')",
		"SELECT pg_terminate_backend(1)",
		"SELECT pg_advisory_lock(1)",
		"SELECT dblink_exec('x', 'DELETE FROM t')",
		"SELECT query_to_xml('DELETE FROM t', true, true, '')",
		"SELECT * FROM t FOR NO KEY UPDATE",
		"EXPLAIN (ANALYZE) DELETE FROM t",
		"SELECT 1; DELETE FROM t",
		"WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d",
		"SELECT E'\\x41'",
		"SELECT * INTO t2 FROM t",
	}
	for _, q := range blocked {
		if _, err := psqlAICommand(q); err == nil {
			t.Errorf("unsafe query accepted: %q", q)
		}
	}
}
