# Client test execution

Run `npm test` with a supported Node version.
The complete suite runs one test file at a time.
Each test keeps its existing assertions, runtime deadlines, and explicit child-process checks.
Tests for competing workers still create and check their own concurrent processes.
This file limit controls test-host resource use. It does not change product execution or research concurrency.

The imported fixture gives each test process a fresh temporary root.
On normal process exit, it removes only that root if its type, device, inode, and owner still match.
It does not remove an older directory, a replacement directory, or a symlink target.
Non-test commands do not receive a new root from the fixture.
A crash can leave synthetic temporary data. A successful test run is not proof of cleanup after every possible crash.

The fixture is test infrastructure, not a production cleanup service.
Tests and this fixture remain outside the installable client archive.
Package metadata can describe a newer test command than an older frozen archive.
Do not replace a frozen archive under its previous hash.

- [ ] Keep complete-suite evidence separate from focused checks and live research acceptance.
- [ ] Run quality control checkpoint
