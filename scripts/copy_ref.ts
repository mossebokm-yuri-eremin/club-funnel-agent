import { selectCarouselReferences } from "../src/services/carousel-template-selector.js";
import { writeFileSync } from "node:fs";
(async () => {
  const r = await selectCarouselReferences({ templateFolderName: "carousel-03-money", voice: "YE", includePortrait: true, includePastPost: true });
  if (!r) return;
  for (const ref of r.refs) {
    const fname = "/var/www/cdn/__ab/REF_" + ref.role + "_" + ref.fileName.replace(/[^a-zA-Z0-9._-]/g, "_") + ".jpg";
    writeFileSync(fname, Buffer.from(ref.base64, "base64"));
    console.log("saved " + fname);
  }
  process.exit(0);
})();
