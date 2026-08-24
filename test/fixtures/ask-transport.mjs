// Runs the real transport prompt and prints its answer, so a pty-driven test can
// assert on arrow keys rather than on the shape of the choice list alone.
import { askTransport } from "../../bin/codex-phone.mjs";

console.log("ANSWER=" + await askTransport());
