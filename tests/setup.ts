/**
 * Before every test file: links fetched for a posting (packages/engine/safe-fetch.ts) are answered by
 * whatever `fetch` is at that moment, so that a test's stand-in for `fetch` answers them and no test
 * reaches the web. The checks of the address and of each redirect still run. The real request, which
 * connects to the checked addresses only, has its own tests (tests/safe-fetch.test.ts).
 */
import { setTransport } from "../packages/engine/safe-fetch";

setTransport((url, _addresses, init) => fetch(url.toString(), { ...init, redirect: "manual" }));
