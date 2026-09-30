// Records tube line status into D1 every five minutes (see wrangler.toml).
//
// The TfL key lives in the Worker secret TFL_APP_KEY. TfL error bodies can
// echo the request URI, key included, so only the status code is ever
// reported.

import {buildTflUpstreamUrl} from '../../../src/helpers/tfl-proxy.mjs';
import {recordServiceSamples} from '../../../src/helpers/service-history.mjs';

const STATUS_PATH = '/Line/Mode/tube/Status';

export async function collectServiceHistory(env, scheduledTime) {
    let response;
    try {
        response = await fetch(buildTflUpstreamUrl(STATUS_PATH, env.TFL_APP_KEY), {
            headers: {Accept: 'application/json'}
        });
    } catch (e) {
        // The underlying error can carry the URL, so it is not rethrown.
        throw new Error('TfL unreachable');
    }
    if (!response.ok) {
        throw new Error(`TfL ${response.status}`);
    }

    const result = await recordServiceSamples(env.DB, await response.json(), scheduledTime);
    console.log(`service history: ${result.samples} lines recorded${result.pruned ? ', old samples pruned' : ''}`);
    return result;
}

export default {
    async scheduled(controller, env) {
        // A throw marks the run as failed in the dashboard; the slot is simply missing.
        await collectServiceHistory(env, controller.scheduledTime || Date.now());
    }
};
