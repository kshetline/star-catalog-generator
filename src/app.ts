import { ExtendedRequestOptions, requestText } from 'by-request';
import { StatOptions, Stats } from 'fs';
import { mkdir, readFile, stat, writeFile } from 'fs/promises';
import { CrossIndex, StarIndex, StarInfo } from './types';
import { asLines, toMixedCase, toNumber } from '@tubular/util';

const bayerRanks =
    'alp bet gam del eps zet eta the iot kap lam mu  nu  xi  omi pi  rho sig tau ups phi chi psi ome '
      .split(/(?<=\w\w. )/).map(s => s.trim());
const constellationCodes =
    ('and ant aps aql aqr ara ari aur boo cae cam cap car cas cen cep cet cha cir cma cmi cnc col com ' +
     'cra crb crt cru crv cvn cyg del dor dra equ eri for gem gru her hor hya hyi ind lac leo lep lib ' +
     'lmi lup lyn lyr men mic mon mus nor oct oph ori pav peg per phe pic psa psc pup pyx ret scl sco ' +
     'sct ser sex sge sgr tau tel tra tri tuc uma umi vel vir vol vul ')
      .split(/(?<=\w\w\w )/).map(s => s.trim());

const CROSS_INDEX_URL = 'http://cdsarc.u-strasbg.fr/ftp/IV/22/index.dat.gz';
const CROSS_INDEX_FILE = 'cache/FK5_SAO_HD_cross_index.txt';

const YALE_BSC_URL = 'http://tdc-www.harvard.edu/catalogs/bsc5.dat.gz';
const YALE_BSC_FILE = 'cache/yale_bsc.txt';

const FK5_NAMES_TO_SKIP = /\d|(^[a-z][a-km-z]? )/;

async function safeStat(path: string, opts?: StatOptions & { bigint?: false }): Promise<Stats> {
  try {
    return await stat(path, opts);
  }
  catch {
    return null;
  }
}

async function getPossiblyCachedFile(file: string, url: string, name: string): Promise<string> {
  const stats = await safeStat(file);
  const opts: ExtendedRequestOptions = { autoDecompress: true };
  let content: string;

  if (stats != null)
    opts.headers = { 'if-modified-since': stats.mtime.toUTCString() };
  else
    console.log(`Retrieving ${name}`);

  try {
    content = await requestText(url, opts);
    console.log(`Updating ${name}`);
    await writeFile(file, content);
  }
  catch (err) {
    if (err.toString().match(/\b304\b/)) {
      console.log(`Using cached ${name}`);
      content = (await readFile(file)).toString();
    }
    else // noinspection ExceptionCaughtLocallyJS
      throw err;
  }

  return content;
}

function processCrossIndex(contents: string): void {
  const lines = asLines(contents);
  const fk5Index: StarIndex = {};
  const hd2fk5: CrossIndex = {};
  // const bscIndex: StarIndex = {};
  // const hd2bsc: CrossIndex = {};
  let totalFK5 = 0;
  // let totalBSC = 0;
  // let totalHIP = 0;
  // let totalDSO = 0;
  // let fk5UpdatesFromHIP = 0;
  // let bscUpdatesFromHIP = 0;
  let highestFK5 = 0;
  // let highestBSC = 0; // Not a real BSC number, last of a series of values starting with highestFK5 + 1
  // let highestHIP = 0; // Not a real Hipparcos number, last of a series of values starting with highestBSC + 1
  let highestStar = 0;
  // let addedStars = 0;
  let lineNo = 0;
  let pleiades = null;

  for (const line of lines) {
    ++lineNo;

    if (line.trim().length === 0)
      continue;

    const star = {} as StarInfo;

    star.fk5Num = toNumber(line.substring(0, 4));
    highestFK5 = Math.max(highestFK5, star.fk5Num);
    highestStar = highestFK5;

    const ra_hours = toNumber(line.substring(6, 8));
    const ra_mins = toNumber(line.substring(9, 11));
    const ra_secs = toNumber(line.substring(12, 18));

    star.RA = ra_hours + ra_mins / 60.0 + ra_secs / 3600.0;
    star.pmRA = toNumber(line.substring(19, 26));

    const de_sign = (line.charAt(27) === '-' ? -1.0 : 1.0);
    const de_degs = toNumber(line.substring(28, 30));
    const de_mins = toNumber(line.substring(31, 33));
    const de_secs = toNumber(line.substring(34, 39));

    star.DE = (de_degs + de_mins / 60.0 + de_secs / 3600.0) * de_sign;
    star.pmDE = toNumber(line.substring(40, 47));
    star.vmag = toNumber(line.substring(59, 64));

    if (line.length >= 92) {
      const hd = toNumber(line.substring(86, 92));

      if (hd > 0)
        hd2fk5[hd] = star.fk5Num;
    }

    const bayerFlamsteed = line.substring(93, 96).toLowerCase();

    if (bayerFlamsteed.length > 0) {
      star.flamsteed = toNumber(bayerFlamsteed);

      if (star.flamsteed === 0) {
        const bayerRank = bayerRanks.indexOf(bayerFlamsteed);

        if (bayerRank >= 0) {
          star.bayerRank = bayerRank + 1;
          star.subIndex = toNumber(line.substring(96, 97));
        }
      }
    }

    if (star.flamsteed !== 0 || star.bayerRank !== 0) {
      const constellationStr = line.substring(98, 101).toLowerCase();
      const constellation = constellationCodes.indexOf(constellationStr);

      if (constellation >= 0)
        star.constellation = constellation + 1;
      else
        star.flamsteed = star.bayerRank = star.subIndex = 0;
    }

    let name = line.substring(103);

    if (name.length > 0) {
      const pos = name.indexOf(';');

      if (pos >= 0)
        name = name.substring(0, pos).trim();

      if (name.length > 0 && !FK5_NAMES_TO_SKIP.test(name))
        star.name = toMixedCase(name);
    }

    ++totalFK5;
    fk5Index[star.fk5Num] = star;

    if (star.fk5Num === 139) { // Look for Alcyone in the Pleiades
      pleiades = {
        messierNum: 45,
        name: 'Pleiades',
        RA: star.RA,
        DE: star.DE,
        pmRA: star.pmRA,
        pmDE: star.pmDE,
        vmag: 1.6
      };
    }
  }

  console.log(fk5Index);
  console.log(hd2fk5);
  console.log('totalFK5:', totalFK5);
  console.log('highestStar:', highestStar);
  console.log('lineNo:', lineNo);
  console.log('pleiades:', pleiades);
  console.log('highestStar:', highestStar);
}

(async (): Promise<void> => {
  try {
    await mkdir('cache', { recursive: true });

    const crossIndex = await getPossiblyCachedFile(CROSS_INDEX_FILE, CROSS_INDEX_URL, 'FK5/SAO/HD cross index');

    processCrossIndex(crossIndex);

    const bscText = await getPossiblyCachedFile(YALE_BSC_FILE, YALE_BSC_URL, 'Yale Bright Star Catalog');

    console.log(bscText.length);
  }
  catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
