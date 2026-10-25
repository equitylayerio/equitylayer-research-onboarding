let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const mode = process.argv[2];
if (mode === "hang") await new Promise(() => setInterval(() => {}, 1000));
else if (mode === "oversize") process.stdout.write("x".repeat(5000));
else if (mode === "stderr") { process.stderr.write("SECRET_SENTINEL".repeat(500)); process.exitCode = 1; }
else if (mode === "fail") { process.stderr.write("SECRET_SENTINEL"); process.exitCode = 1; }
else if (mode === "multiple") process.stdout.write("{}\n{}");
else if (mode === "invalid") process.stdout.write("not json");
else if (mode === "array") process.stdout.write("[]");
else if (mode === "missing") process.stdout.write("{}");
else {
  const value = { agent_fields: { input: request.input, args: process.argv.slice(3), has_key: !!process.env.SYNTHETIC_SECRET } };
  if (mode === "known") value.usage = { tokens: 3, cost_microusd: 4 };
  if (mode === "badusage") value.usage = { tokens: -1, cost_microusd: 0 };
  process.stdout.write(JSON.stringify(value));
}
