import { loadJSON, saveJSON, buildLookup } from './helpers';

export default async function () {

    const DATA_DIR = process.env.MT3D_DATA_DIR || 'data';
    const data = await loadJSON(`${DATA_DIR}/railways.json`);

    const lookup = buildLookup(data);

    saveJSON('build/data/railways.json.gz', data.filter(({ del }) => !del));

    console.log('Railway data was loaded');

    return lookup;

}
