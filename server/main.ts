import { GelApp } from "./app.ts";
import { createApi } from "./api.ts";
import { mkdirSync } from "node:fs";

mkdirSync("data", { recursive: true });
const app = new GelApp("data/gel-ruler.db", "casepack/gel-ruler");
if (app.store.events().length === 0) {
  const r = app.seed();
  if (!r.ok) console.error("seed failed", r.diagnostics);
  else console.log(`seeded casepack: ${r.value.imported} materials, ${r.value.computed} derived results`);
}
const port = Number(process.env.API_PORT ?? 5343);
createApi(app, port);
console.log(`gel-ruler API on http://127.0.0.1:${port}`);
