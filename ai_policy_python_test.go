package main

import "testing"

func TestAIPythonSafeRejectsPrivateModuleAccess(t *testing.T) {
	unsafe := []string{
		"import random\nrandom._os.remove('/tmp/victim')",
		"import random\nrandom._os.system('id')",
		"import random as rng\nrng._os.remove('/tmp/victim')",
		"from random import _os\n_os.remove('/tmp/victim')",
		"from random import _os as os\nos.remove('/tmp/victim')",
		"from random._os import system\nsystem('id')",
		"import random._os",
		"import random._os as private_os",
		"import math\nmath._internal",
		"f = open\nf('/tmp/victim', 'w').write('changed')",
		"run = exec\nrun(\"print(1)\")",
		"lookup = getattr\nlookup(random, '_os')",
		"ｏｐｅｎ('/tmp/victim', 'w').write('changed')",
		"f\"{ｏｐｅｎ('/tmp/victim', 'w')}\"",
		"import operator, random\noperator.attrgetter('_os')(random).remove('/tmp/victim')",
		"import time\ntime.sleep(1000)",
		"f.write('changed')",
		"cursor.execute('DELETE FROM users')",
		"session.post('https://example.invalid')",
		"file.read()",
	}
	for _, code := range unsafe {
		if aiPythonSafe(code) {
			t.Errorf("private Python module access unexpectedly accepted: %q", code)
		}
	}
}

func TestAIPythonSafeKeepsPureCalculationsQuiet(t *testing.T) {
	safe := []string{
		"1 + 1",
		"import math\nmath.sqrt(9)",
		"from decimal import Decimal\nDecimal('1.25')",
		"import random\nrandom.randint(1, 10)",
		"message = '中文'; message",
		"# 中文注释\n1 + 1",
	}
	for _, code := range safe {
		if !aiPythonSafe(code) {
			t.Errorf("pure Python calculation unexpectedly rejected: %q", code)
		}
	}
}

func TestAIPythonPrivateModuleAccessRequiresApproval(t *testing.T) {
	code := "import random\nrandom._os.remove('/tmp/victim')"
	for _, mode := range []string{"review", "auto"} {
		got := aiToolApproval(mode, "ssh_exec", "python", code, "", false)
		if !got.Required || got.Policy != "python" {
			t.Errorf("%s mode did not require Python approval for private module access: %+v", mode, got)
		}
	}
}
