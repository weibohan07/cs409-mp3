// Self-check your MP3 against the course autograder.
//
// 1. Deploy your API and set API_URL in .env/the environment, or edit the constant below.
//    Use the public origin without /api; the course grader adds /api itself.
// 2. Run:  npm run submit    (or: node submit.js)
//
// The autograder cannot reach localhost, so API_URL must be your deployed URL.
// Requires Node 24 (LTS).

require("dotenv").config({ quiet: true });

const API_URL = "https://YOUR-APP-NAME.onrender.com"; // <-- change this to your deployed API's URL

// Grader URL; DO NOT CHANGE.
const AUTOGRADER_URL = "https://cs409-mp3-grader.onrender.com";

const TIMEOUT_MS = 6 * 60 * 1000; // a free-tier Render app may need a minute to wake up

function fail(message) {
    console.error(`\n${message}\n`);
    process.exit(1);
}

function resolveApiUrl() {
    const configured = (process.env.API_URL || API_URL).trim().replace(/\/+$/, "");
    if (!configured || configured.includes("YOUR-APP-NAME")) {
        fail("Set API_URL in .env/the environment, or edit API_URL in submit.js, to your public deployment origin (without /api).");
    }
    let parsed;
    try {
        parsed = new URL(configured);
    } catch {
        fail("API_URL must be an absolute http:// or https:// URL.");
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
        fail("API_URL must use http:// or https://.");
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") {
        fail("API_URL must be only your deployment origin, with no credentials, path (including /api), query, or fragment.");
    }
    const host = parsed.hostname.toLowerCase();
    const octets = host.split(".").map(Number);
    const privateV4 = octets.length === 4 && octets.every(Number.isInteger) && (
        octets[0] === 0 || octets[0] === 10 || octets[0] === 127 ||
        (octets[0] === 169 && octets[1] === 254) ||
        (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
        (octets[0] === 192 && octets[1] === 168)
    );
    const localHost = host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
        host === "[::1]" || host === "[::]" || /^\[(?:fc|fd|fe[89ab])/i.test(host);
    if (privateV4 || localHost || (!host.includes(".") && !host.startsWith("["))) {
        fail("The course grader needs a publicly reachable API_URL; localhost and private/local network addresses cannot be used.");
    }
    return parsed.origin;
}

async function main() {
    const apiUrl = resolveApiUrl();
    if (AUTOGRADER_URL.includes("REPLACE-WITH")) {
        fail("AUTOGRADER_URL has not been configured. Please contact the course staff.");
    }

    console.log(`Submitting ${apiUrl} to the autograder...`);
    console.log("This can take a few minutes (the autograder runs many requests against your API).\n");

    let res;
    try {
        res = await fetch(`${AUTOGRADER_URL.replace(/\/+$/, "")}/grade`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: apiUrl }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
    } catch (e) {
        fail(`Could not reach the autograder (${e.name === "TimeoutError" ? "timed out" : e.message}). Try again in a minute.`);
    }

    let result;
    try {
        result = await res.json();
    } catch {
        fail(`The autograder returned an unexpected response (HTTP ${res.status}).`);
    }
    if (!res.ok) {
        fail(`Autograder error (HTTP ${res.status}): ${result.error || JSON.stringify(result)}`);
    }

    const label = { passed: "PASS   ", partial: "PARTIAL", failed: "FAIL   " };
    for (const t of result.tests) {
        console.log(`[${label[t.status] || t.status}] ${t.test}  (${t.awardedScore}/${t.possibleScore})`);
        for (const m of t.messages) console.log(`           - ${m}`);
    }
    console.log(`\nScore: ${result.score}/100  (${result.awardedPoints}/${result.totalPoints} points)\n`);
}

main();
