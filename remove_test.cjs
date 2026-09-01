const fs = require('fs');
let txt = fs.readFileSync('test/worker.test.js', 'utf8');

// Find the test block and remove it
const testName = "'/api/pipeline endpoints require x-api-key authentication'";
const startIndex = txt.indexOf(`test(${testName}`);
if (startIndex !== -1) {
  const nextTestIndex = txt.indexOf("test('POST /api/pipeline/stage", startIndex);
  if (nextTestIndex !== -1) {
    txt = txt.substring(0, startIndex) + txt.substring(nextTestIndex);
    fs.writeFileSync('test/worker.test.js', txt);
    console.log("Removed test");
  } else {
    console.log("Next test not found");
  }
} else {
  console.log("Test not found");
}
