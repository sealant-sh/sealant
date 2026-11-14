// A vitest reporter `pnpm verify` adds beside the default one: it writes every test's outcome to
// $SEALANT_VERIFY_REPORT_DIR, one file per vitest process, so `verify` can see which tests skipped.
// (turbo passes SEALANT_* through to `test`, turbo.json.)
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export default class VerifyReporter {
  onTestRunEnd(testModules) {
    const directory = process.env.SEALANT_VERIFY_REPORT_DIR;
    if (directory === undefined || directory === "") return;
    const tests = [];
    for (const testModule of testModules) {
      for (const testCase of testModule.children.allTests()) {
        tests.push({
          file: testModule.moduleId,
          name: testCase.fullName,
          state: testCase.result().state,
        });
      }
    }
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, `${process.pid}-${Date.now()}.json`),
      JSON.stringify({ cwd: process.cwd(), tests }),
    );
  }
}
