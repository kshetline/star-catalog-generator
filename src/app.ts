import { ExtendedRequestOptions, requestText } from 'by-request';
import { StatOptions, Stats } from 'fs';
import { mkdir, readFile, stat, writeFile } from 'fs/promises';
import { CrossIndex, StarIndex, StarInfo } from './types';
import { asLines, processMillis, toMixedCase, toNumber } from '@tubular/util';
import { cos } from '@tubular/math';
import * as https from 'https';

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
const YALE_BSC_NOTES_URL = 'http://tdc-www.harvard.edu/catalogs/bsc5.notes.gz';
const YALE_BSC_NOTES_FILE = 'cache/yale_bsc_notes.txt';

const THREE_MONTHS = 90 * 86400 * 1000;

const HIPPARCOS_URL = 'https://heasarc.gsfc.nasa.gov/db-perl/W3Browse/w3query.pl';
const HIPPARCOS_FILE = 'cache/hipparcos.txt';
/* cspell:disable */ // noinspection SpellCheckingInspection
const HIPPARCOS_PARAMS = 'tablehead=name%3Dheasarc_hipparcos%26description%3DHipparcos+Main+Catalog%26url%3Dhttps%3A%2F%2Fheasarc.gsfc.nasa.gov%2FW3Browse%2Fstar-catalog%2Fhipparcos.html%26archive%3DN%26radius%3D1%26mission%3DSTAR+CATALOG%26priority%3D3%26tabletype%3DObject&sortvar=hip_number&varon=pm_ra&bparam_pm_ra=&bparam_pm_ra%3A%3Aunit=mas%2Fyr&bparam_pm_ra%3A%3Aformat=float8%3A8.2f&varon=pm_dec&bparam_pm_dec=&bparam_pm_dec%3A%3Aunit=mas%2Fyr&bparam_pm_dec%3A%3Aformat=float8%3A8.2f&varon=hip_number&bparam_hip_number=&bparam_hip_number%3A%3Aformat=int4%3A6d&varon=vmag&bparam_vmag=%3C%3D12&bparam_vmag%3A%3Aunit=mag&bparam_vmag%3A%3Aformat=float8%3A5.2f&bparam_vmag_source=&bparam_vmag_source%3A%3Aformat=char1&varon=ra_deg&bparam_ra_deg=&bparam_ra_deg%3A%3Aunit=degree&bparam_ra_deg%3A%3Aformat=char12&varon=dec_deg&bparam_dec_deg=&bparam_dec_deg%3A%3Aunit=degree&bparam_dec_deg%3A%3Aformat=char12&varon=hd_id&bparam_hd_id=&bparam_hd_id%3A%3Aformat=int4%3A6d&Entry=&Coordinates=J2000&Radius=Default&Radius_unit=arcsec&NR=CheckCaches%2FGRB%2FSIMBAD%2BSesame%2FNED&Time=&ResultMax=0&displaymode=PureTextDisplay&Action=Start+Search&table=heasarc_hipparcos';

// Legacy inclusion from the original SVC short star catalog -- include them in output regardless of other criteria.
const bscExtras = [8, 87, 340, 1643, 1751, 3732, 4030, 4067, 4531, 5223, 5473, 5714, 5888, 6970, 8076];

// 6.0, 0.0 for small catalog
const magLimitBSC = 12.0;
// const magLimitHipparcos = 7.25;

const FK5_NAMES_TO_SKIP = /\d|(^[a-z][a-km-z]? )/;

async function safeStat(path: string, opts?: StatOptions & { bigint?: false }): Promise<Stats> {
  try {
    return await stat(path, opts);
  }
  catch {
    return null;
  }
}

function toError(err: any): Error {
  return Error ? err : new Error((err as any).toString());
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

async function getHipparcosData(): Promise<string> {
  const stats = await safeStat(HIPPARCOS_FILE);
  let isUpdate = false;

  if (!stats)
    console.log('Retrieving Hipparcos data');
  else if (stats.mtimeMs > Date.now() - THREE_MONTHS) {
    console.log('Using cached data');
    return (await readFile(HIPPARCOS_FILE)).toString('ascii');
  }
  else
    isUpdate = true;

  return new Promise<string>((resolve, reject) => {
    const req = https.request(HIPPARCOS_URL, { method: 'POST' }, res => {
      let result = '';
      let lastTick = processMillis();

      res.setEncoding('ascii');

      res.on('data', (data: Buffer) => {
        if (processMillis() > lastTick + 2000) {
          process.stdout.write('.');
          lastTick = processMillis();
        }

        result += data.toString('ascii');
      });

      res.on('error', err => reject(toError(err)));

      res.on('end', () => {
        process.stdout.write('\n');

        if (isUpdate)
          console.log('Updating Hipparcos data');

        writeFile(HIPPARCOS_FILE, result).then(() => resolve(result)).catch(err => reject(toError(err)));
      });
    });

    req.write(HIPPARCOS_PARAMS, err => {
      if (err)
        reject(toError(err));
      else
        req.end();
    });
  });
}

const fk5Index: StarIndex = {};
const hd2fk5: CrossIndex = {};
const bscIndex: StarIndex = {};
const hd2bsc: CrossIndex = {};
let totalFK5 = 0;
let totalBSC = 0;
// let totalHIP = 0;
// let totalDSO = 0;
// let fk5UpdatesFromHIP = 0;
// let bscUpdatesFromHIP = 0;
let highestFK5 = 0;
let highestBSC = 0; // Not a real BSC number, last of a series of values starting with highestFK5 + 1
// let highestHIP = 0; // Not a real Hipparcos number, last of a series of values starting with highestBSC + 1
let highestStar = 0;
let addedStars = 0;
let pleiades: StarInfo;

function processCrossIndex(contents: string): void {
  const lines = asLines(contents);
  let lineNo = 0;

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

  console.log(!!fk5Index);
  console.log(!!hd2fk5);
  console.log('totalFK5:', totalFK5);
  console.log('highestStar:', highestStar);
  console.log('lineNo:', lineNo);
  console.log('pleiades:', pleiades);
  console.log('highestStar:', highestStar);
}

function processYaleBrightStarCatalog(contents: string): void {
  const lines = asLines(contents);
  let lineNo = 0;
  const bsc2fk5: CrossIndex = {};
  let dupes = 0;
  let lastBSC = -1;
  let currBSC: number;
  let lastFK5 = -1;
  let currFK5: number;
  let lastName = '';
  let currName: string;
  let lastMag = 999.9;
  let currMag: number;

  for (const line of lines) {
    ++lineNo;

    if (line.trim().length === 0)
      continue;

    currBSC = toNumber(line.substring(0, 4));
    bsc2fk5[currBSC] = 0; // Mark as not matched to an FK5 star, but not a duplicate either.
    currName = line.substring(4, 14);

    const fk5str = line.substring(37, 41).trim();

    if (fk5str.length === 0)
      currFK5 = 0;
    else {
      currFK5 = toNumber(fk5str);

      if (currFK5 > highestFK5)
        currFK5 = 0;
    }

    const vmagStr = line.substring(102, 107).trim();

    if (vmagStr.length === 0)
      continue;

    currMag = toNumber(vmagStr);

    if (currName === lastName && currName.trim().length > 0) {
      lastFK5 = currFK5 = Math.max(lastFK5, currFK5);
      bsc2fk5[lastBSC] = currFK5;
      bsc2fk5[currBSC] = currFK5;
      ++dupes;

      if (currMag >= lastMag) {
        delete bsc2fk5[currBSC];

        continue;
      }
      else
        delete bsc2fk5[lastBSC];
    }

    lastBSC = currBSC;
    lastFK5 = currFK5;
    lastName = currName;
    lastMag = currMag;
  }

  console.log('First scan of Bright Star Catalog complete. Duplicates eliminated:', dupes);
  lineNo = 0;

  for (const line of lines) {
    ++lineNo;

    if (line.trim().length === 0)
      continue;

    const bscNum = toNumber(line.substring(0, 4));

    if (!bsc2fk5[bscNum] != null) // Skip past stars flagged as dupes.
      continue;

    const fk5str = line.substring(37, 41).trim();
    let fk5Num: number;

    if (fk5str.length === 0)
      fk5Num = bsc2fk5[bscNum];
    else {
      fk5Num = toNumber(fk5str);

      if (fk5Num > highestFK5)
        fk5Num = 0;
    }

    const vmagStr = line.substring(102, 107).trim();

    if (vmagStr.length === 0)
      continue;

    const vmag = toNumber(vmagStr);
    const name = line.substring(4, 14);
    const bayerRankStr = name.substring(3, 6).toLowerCase();
    let bayerRank = bayerRanks.indexOf(bayerRankStr);

    if (bayerRank >= 0)
      ++bayerRank;
    else
      bayerRank = 0;

    if ((vmag <= magLimitBSC || bscExtras.includes(bscNum) || (bayerRank > 0 &&
         ((bayerRank < 12 && vmag <= 5.5) || (bayerRank < 6 && vmag <= 6.0)))) &&
        (fk5Num === 0 || fk5Num > highestFK5 || !!fk5Index[fk5Num])) {
      ++addedStars;
      fk5Num = highestFK5 + addedStars;

      const star = {} as StarInfo;

      star.vmag = vmag;

      const ra_hours = toNumber(line.substring(75, 77));
      const ra_mins = toNumber(line.substring(77, 79));
      const ra_secs = toNumber(line.substring(79, 83));

      star.RA = ra_hours + ra_mins / 60.0 + ra_secs / 3600.0;

      const de_sign = (line.charAt(83) === '-' ? -1.0 : 1.0);
      const de_degs = toNumber(line.substring(84, 86));
      const de_mins = toNumber(line.substring(86, 88));
      const de_secs = toNumber(line.substring(88, 90));

      star.DE = (de_degs + de_mins / 60.0 + de_secs / 3600.0) * de_sign;
      star.pmRA = toNumber(line.substring(148, 154)) * 6.6667 / cos(star.DE * Math.PI / 180.0);
      star.pmDE = toNumber(line.substring(154, 160)) * 100.0;

      fk5Index[fk5Num] = star;
      ++totalBSC;
      highestBSC = fk5Num;
      highestStar = fk5Num;
    }

    console.log(totalBSC, highestBSC);

    if (fk5Num > 0 && !!fk5Index[fk5Num]) {
      const star = fk5Index[fk5Num];

      star.bscNum = bscNum;
      bsc2fk5[bscNum] = fk5Num;
      bscIndex[bscNum] = star;

      const hd = toNumber(line.substring(25, 31));

      if (hd > 0)
        hd2bsc[hd] = star.bscNum;

      if (name.trim().length > 0) {
        let flamsteed: number;
        const flamsteedStr = name.substring(0, 3).trim();

        if (flamsteedStr.length === 0)
          flamsteed = 0;
        else
          flamsteed = toNumber(flamsteedStr);

        const subIndexStr = name.substring(6, 7);
        let subIndex = 0;

        if (subIndexStr !== ' ')
          subIndex = toNumber(subIndexStr);

        const constellationStr = name.substring(7, 10).toLowerCase();
        let constellation = constellationCodes.indexOf(constellationStr);

        if (constellation >= 0)
          ++constellation;
        else
          constellation = 0;

        star.flamsteed = flamsteed;
        star.bayerRank = bayerRank;
        star.subIndex = subIndex;
        star.constellation = constellation;
      }
    }
  }

  console.log(lineNo);
  Object.keys(bsc2fk5).forEach((key: any) => { if (bsc2fk5[key] === 0) delete bsc2fk5[key]; });
  console.log(!!bsc2fk5);
}

(async (): Promise<void> => {
  try {
    console.log(await getHipparcosData());
    await mkdir('cache', { recursive: true });

    const crossIndex = await getPossiblyCachedFile(CROSS_INDEX_FILE, CROSS_INDEX_URL, 'FK5/SAO/HD cross index');

    processCrossIndex(crossIndex);

    const bscCatalog = await getPossiblyCachedFile(YALE_BSC_FILE, YALE_BSC_URL, 'Yale Bright Star Catalog');
    const bscNotes = await getPossiblyCachedFile(YALE_BSC_NOTES_FILE, YALE_BSC_NOTES_URL, 'Yale Bright Star Notes');
    console.log(bscNotes.length);

    processYaleBrightStarCatalog(bscCatalog);
  }
  catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
