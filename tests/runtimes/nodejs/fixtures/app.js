const path = require("path");
const { square, cube } = require("./math");
const config = require("./config.json");
const greet = require("greet");

const out = [];
out.push(`name=${config.name}`);
out.push(`maxItems=${config.limits.maxItems}`);
out.push(`square(4)=${square(4)}`);
out.push(`cube(3)=${cube(3)}`);
out.push(`greet=${greet("wasmhub")}`);
out.push(`__filename basename=${path.basename(__filename)}`);
out.push(`require.main===module: ${require.main === module}`);

console.log(out.join("\n"));
