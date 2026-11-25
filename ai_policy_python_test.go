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
	}
	for _, code := range safe {
		if !aiPythonSafe(code) {
			t.Errorf("pure Python calculation unexpectedly rejected: %q", code)
		}
	}
}
