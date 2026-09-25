import { buildCasePack } from "../src/server/casepack-gen.js";
import { casePackDir } from "../src/server/paths.js";

const { manifest, png } = buildCasePack(casePackDir());
console.log("case pack written:", manifest.id, png.length, "bytes");
