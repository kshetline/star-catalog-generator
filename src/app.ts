import { ExtendedRequestOptions, requestText } from 'by-request';
import { StatOptions, Stats } from 'fs';
import { mkdir, readFile, stat } from 'fs/promises';
import { CrossIndex, NGCMatchInfo, StarIndex, StarInfo } from './types';
import { asLines, processMillis, toMixedCase, toNumber } from '@tubular/util';
import { abs, cos, floor, max, min } from '@tubular/math';
import BinaryFile from 'binary-file';

const bayerRanks =
    'alp bet gam del eps zet eta the iot kap lam mu nu xi omi pi rho sig tau ups phi chi psi ome'
      .split(/\s+/);
const constellationCodes =
    ('and ant aps aql aqr ara ari aur boo cae cam cap car cas cen cep cet cha cir cma cmi cnc col com ' +
     'cra crb crt cru crv cvn cyg del dor dra equ eri for gem gru her hor hya hyi ind lac leo lep lib ' +
     'lmi lup lyn lyr men mic mon mus nor oct oph ori pav peg per phe pic psa psc pup pyx ret scl sco ' +
     'sct ser sex sge sgr tau tel tra tri tuc uma umi vel vir vol vul')
      .split(/\s+/);

const CROSS_INDEX_URL = 'http://cdsarc.u-strasbg.fr/ftp/IV/22/index.dat.gz';
const CROSS_INDEX_FILE = 'cache/FK5_SAO_HD_cross_index.txt';

const YALE_BSC_URL = 'http://tdc-www.harvard.edu/catalogs/bsc5.dat.gz';
const YALE_BSC_FILE = 'cache/yale_bsc.txt';
const YALE_BSC_NOTES_URL = 'http://tdc-www.harvard.edu/catalogs/bsc5.notes.gz';
const YALE_BSC_NOTES_FILE = 'cache/yale_bsc_notes.txt';

const THREE_MONTHS = 90 * 86400 * 1000;

const HIPPARCOS_URL = 'https://heasarc.gsfc.nasa.gov/db-perl/W3Browse/w3query.pl';
const HIPPARCOS_FILE = 'cache/hipparcos.txt';
const MAG_LIMIT_HIPPARCOS_QUERY = 7.0;
/* cspell:disable */ // noinspection SpellCheckingInspection
const HIPPARCOS_PARAMS = 'tablehead=name%3Dheasarc_hipparcos%26description%3DHipparcos+Main+Catalog' +
  '%26url%3Dhttps%3A%2F%2Fheasarc.gsfc.nasa.gov%2FW3Browse%2Fstar-catalog%2Fhipparcos.html%26archive%3DN%26radius%3D1' +
  '%26mission%3DSTAR+CATALOG%26priority%3D3%26tabletype%3DObject' +
  '&sortvar=vmag&varon=pm_ra&bparam_pm_ra=&bparam_pm_ra%3A%3Aunit=mas%2Fyr&bparam_pm_ra%3A%3Aformat=float8%3A8.2f&varon=pm_dec' +
  '&bparam_pm_dec=&bparam_pm_dec%3A%3Aunit=mas%2Fyr&bparam_pm_dec%3A%3Aformat=float8%3A8.2f&varon=hip_number&bparam_hip_number=' +
  '&bparam_hip_number%3A%3Aformat=int4%3A6d&varon=vmag' +
  '&bparam_vmag=%3C%3D' + MAG_LIMIT_HIPPARCOS_QUERY + '&bparam_vmag%3A%3Aunit=mag&bparam_vmag%3A%3Aformat=float8%3A5.2f' +
  '&bparam_vmag_source=&bparam_vmag_source%3A%3Aformat=char1&varon=ra_deg&bparam_ra_deg=&bparam_ra_deg%3A%3Aunit=degree' +
  '&bparam_ra_deg%3A%3Aformat=char12&varon=dec_deg&bparam_dec_deg=&bparam_dec_deg%3A%3Aunit=degree&bparam_dec_deg%3A%3Aformat=char12' +
  '&varon=hd_id&bparam_hd_id=&bparam_hd_id%3A%3Aformat=int4%3A6d&Entry=&Coordinates=J2000&Radius=Default&Radius_unit=arcsec' +
  '&NR=CheckCaches%2FGRB%2FSIMBAD%2BSesame%2FNED&Time=&ResultMax=0&displaymode=PureTextDisplay&Action=Start+Search&table=heasarc_hipparcos';
/* cspell:enable */

const NGC_NAMES_URL = 'https://cdsarc.cds.unistra.fr/viz-bin/nph-Cat/txt.gz?VII/118/names.dat';
const NGC_NAMES_FILE = 'cache/ngc_names.txt';
const NGC_DATA_URL  = 'https://cdsarc.cds.unistra.fr/viz-bin/nph-Cat/txt.gz?VII/118/ngc2000.dat';
const NGC_DATA_FILE  = 'cache/ngc_2000_data.txt';

// Legacy inclusion from the original SVC short star catalog -- include them in output regardless of other criteria.
const bscExtras = [8, 87, 340, 1643, 1751, 3732, 4030, 4067, 4531, 5223, 5473, 5714, 5888, 6970, 8076];

const magLimitBSC = 6;
const magLimitHipparcos = 6.25;

const FK5_NAMES_TO_SKIP = /\d|(^[a-z][a-km-z]? )/;

async function safeStat(path: string, opts?: StatOptions & { bigint?: false }): Promise<Stats> {
  try {
    return await stat(path, opts);
  }
  catch {
    return null;
  }
}

async function getPossiblyCachedFile(file: string, url: string, name: string,
                                     extraOpts?: ExtendedRequestOptions): Promise<string> {
  let tickShown = false;
  let lastTick = processMillis();
  const autoTick = setInterval(() => {
    const now = processMillis();

    if (now > lastTick + 500) {
      tickShown = true;
      process.stdout.write('???');
      lastTick = now;
    }
  }, 1500);
  const opts: ExtendedRequestOptions = { autoDecompress: true, cachePath: file, progress: () => {
    const now = processMillis();

    if (now > lastTick + 500) {
      tickShown = true;
      process.stdout.write('???');
      lastTick = now;
    }
  } };
  const stats = await safeStat(file);

  if (extraOpts)
    Object.assign(opts, extraOpts);

  if (!stats)
    console.log(`Retrieving ${name}`);

  let content: string;

  try {
    content = await requestText(url, opts);

    clearInterval(autoTick);

    if (tickShown)
      process.stdout.write('\n');

    const postStats = await safeStat(file);

    if (stats) {
      if (postStats.mtimeMs > stats.mtimeMs)
        console.log(`Updating ${name}`);
      else
        console.log(`Using cached ${name}`);
    }
  }
  catch (err) {
    console.error(`Failed to acquire ${name}. Will used archived copy.`);
    content = await readFile(file.replace(/^cache\//, 'archive/'), 'utf-8');
  }

  return content;
}

const fk5Index: StarIndex = {};
const hd2fk5: CrossIndex = {};
const bscIndex: StarIndex = {};
const hd2bsc: CrossIndex = {};
let totalFK5 = 0;
let totalBSC = 0;
let totalHIP = 0;
let totalDSO = 0;
let fk5UpdatesFromHIP = 0;
let bscUpdatesFromHIP = 0;
let highestFK5 = 0;
let highestBSC = 0; // Not a real BSC number, last of a series of values starting with highestFK5 + 1
let highestHIP = 0; // Not a real Hipparcos number, last of a series of values starting with highestBSC + 1
let highestStar = 0;
let addedStars = 0;
let total = 0;
let missingFK5 = 0;
let bMag = 999.9;
let dMag = -999.9;
let pleiades: StarInfo;
const bsc2fk5: CrossIndex = {};
const ngcs: Record<number, NGCMatchInfo> = {};

function processCrossIndex(contents: string): void {
  const lines = asLines(contents);

  for (const line of lines) {
    if (!line.trim())
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

    const bayerFlamsteed = line.substring(93, 96).trim().toLowerCase();

    if (bayerFlamsteed) {
      star.flamsteed = toNumber(bayerFlamsteed);

      if (star.flamsteed === 0) {
        star.bayerRank = bayerRanks.indexOf(bayerFlamsteed) + 1;

        if (star.bayerRank > 0)
          star.subIndex = toNumber(line.substring(96, 97));
      }
    }
    else
      star.flamsteed = 0;

    if (star.flamsteed !== 0 || star.bayerRank !== 0) {
      star.constellation = constellationCodes.indexOf(line.substring(98, 102).trim().toLowerCase().replace('pet', 'peg')) + 1;

      if (star.constellation === 0)
        star.flamsteed = star.bayerRank = star.subIndex = 0;
    }

    let name = line.substring(103).trim();

    if (name) {
      const pos = name.indexOf(';');

      if (pos >= 0)
        name = name.substring(0, pos).trim();

      if (name && !FK5_NAMES_TO_SKIP.test(name))
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
}

function processYaleBrightStarCatalog(contents: string): void {
  const lines = asLines(contents);
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
    if (!line.trim())
      continue;

    currBSC = toNumber(line.substring(0, 4));
    bsc2fk5[currBSC] = 0; // Mark as not matched to an FK5 star, but not a duplicate either.
    currName = line.substring(4, 14);
    currFK5 = toNumber(line.substring(37, 41));

    if (currFK5 > highestFK5)
      currFK5 = 0;

    const vmagStr = line.substring(102, 107).trim();

    if (!vmagStr)
      continue;

    currMag = toNumber(vmagStr);

    if (currName === lastName && currName.trim()) {
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

  for (const line of lines) {
    if (!line.trim())
      continue;

    const bscNum = toNumber(line.substring(0, 4));

    if (bsc2fk5[bscNum] == null) // Skip past stars flagged as dupes.
      continue;

    const fk5str = line.substring(37, 41).trim();
    let fk5Num: number;

    if (!fk5str)
      fk5Num = bsc2fk5[bscNum];
    else {
      fk5Num = toNumber(fk5str);

      if (fk5Num > highestFK5)
        fk5Num = 0;
    }

    const vmagStr = line.substring(102, 107).trim();

    if (!vmagStr)
      continue;

    const vmag = toNumber(vmagStr);
    const name = line.substring(4, 14);
    const bayerRankStr = name.substring(3, 6).trim().toLowerCase();
    const bayerRank = bayerRanks.indexOf(bayerRankStr) + 1;

    if ((vmag <= magLimitBSC || bscExtras.includes(bscNum) || (bayerRank > 0 &&
         ((bayerRank < 14 && vmag <= 6) || (bayerRank < 8 && vmag <= 6.5)))) &&
        (fk5Num === 0 || fk5Num > highestFK5 || !fk5Index[fk5Num])) {
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

    if (fk5Num > 0 && fk5Index[fk5Num]) {
      const star = fk5Index[fk5Num];

      star.bscNum = bscNum;
      bsc2fk5[bscNum] = fk5Num;
      bscIndex[bscNum] = star;

      const hd = toNumber(line.substring(25, 31));

      if (hd > 0)
        hd2bsc[hd] = star.bscNum;

      if (name.trim()) {
        star.flamsteed = toNumber(name.substring(0, 3).trim());
        star.bayerRank = bayerRank;
        star.subIndex = toNumber(name.substring(6, 7));
        star.constellation = constellationCodes.indexOf(name.substring(7, 10).toLowerCase()) + 1;
      }
    }
  }
}

function processYaleBrightStarCatalogNotes(contents: string): void {
  const lines = asLines(contents);
  let nameCount = 0;

  for (const line of lines) {
    if (!line.trim())
      continue;

    const bscNum = toNumber(line.substring(0, 5));

    if (bsc2fk5[bscNum] === 0)
      continue;

    const code = line.substring(5, 11).trim();

    if (code !== '1N:')
      continue;

    const name = (/^([A-Z][A-Z ]+)[.;]/.exec(line.substring(12)) ?? [])[1];

    if (name) {
      ++nameCount;
      fk5Index[bsc2fk5[bscNum]].name = toMixedCase(name);
    }
  }

  console.log('Full star names found:', nameCount);
}

function processHipparcosStarCatalog(contents: string): void {
  const lines = asLines(contents);

  for (const line of lines) {
    if (!/^\|[^a-z]/i.test(line.trim()))
      continue;

    const parts = line.split('|').map(s => s.trim());
    const hipNum = toNumber(parts[3]);
    const hdNum = toNumber(parts[7]);

    if (!hipNum)
      continue;

    const raStr   = parts[5];
    const deStr   = parts[6];
    const vmagStr = parts[4];
    const pmRAStr = parts[1];
    const pmDEStr = parts[2];

    if (!raStr || !deStr || !vmagStr || !pmRAStr || !pmDEStr)
      continue;

    const vmag = toNumber(vmagStr);
    let fk5Num = 0;
    let bscNum = 0;
    let addStar = false;
    let star: StarInfo;

    if (hdNum > 0) {
      fk5Num = toNumber(hd2fk5[hdNum]);
      bscNum = toNumber(hd2bsc[hdNum]);
    }

    if (fk5Num > 0) {
      star = fk5Index[fk5Num];
      ++fk5UpdatesFromHIP;
    }
    else if (bscNum > 0) {
      star = bscIndex[bscNum];
      ++bscUpdatesFromHIP;
    }
    else if (vmag > magLimitHipparcos)
      break;
    else {
      star = {} as StarInfo;
      star.hipNum = hipNum;
      addStar = true;
    }

    star.vmag = min(vmag, star.vmag ?? vmag);
    star.RA   = toNumber(raStr) / 15.0;
    star.DE   = toNumber(deStr);
    star.pmRA = toNumber(pmRAStr) * 0.0066667 / cos(star.DE * Math.PI / 180.0);
    star.pmDE = toNumber(pmDEStr) / 10.0;

    if (addStar) {
      ++addedStars;
      fk5Num = highestFK5 + addedStars;
      fk5Index[fk5Num] = star;
      ++totalHIP;
      highestHIP = fk5Num;
      highestStar = fk5Num;
    }
  }

  if (pleiades) {
    ++totalDSO;
    fk5Index[highestStar + totalDSO] = pleiades;
    console.log('Alcyone found, M45 Pleiades item added.');
  }
}

function processNgcNames(contents: string): void {
  const lines = asLines(contents);
  let ngcIcNum: number;
  let namedNSOs = 0;
  let ngcIcStr: string;
  let ngcInfo: NGCMatchInfo;
  let messierNum: number;
  let dividerCount = 0;

  for (const line of lines) {
    if (line.startsWith('-')) {
      ++dividerCount;
      continue;
    }
    else if (!line || dividerCount < 2)
      continue;

    const parts = line.split('|');

    ngcIcStr = parts[1];

    if (!ngcIcStr)
      continue;

    ngcIcNum = toNumber(ngcIcStr.substring(1)) * (ngcIcStr.startsWith('I') ? -1 : 1);

    if (!ngcIcNum)
      continue;

    let name = parts[0].trim();

    if (name === 'Great Nebula in Andromeda')
      name = 'Andromeda galaxy';

    if (name.startsWith('M ')) {
      messierNum = toNumber(name.substring(1));
      name = '';
    }
    else
      messierNum = 0;

    ngcInfo = ngcs[ngcIcNum];

    if (!ngcInfo) {
      ++namedNSOs;
      ngcInfo = { ngcIcNum, messierNum, name };
      ngcs[ngcIcNum] = ngcInfo;
    }
    else {
      if (!ngcInfo.name)
        ngcInfo.name = name;
      else if (name.length > 0)
        ngcInfo.name += '/' + name;

      if (ngcInfo.messierNum && messierNum)
        console.log(`M${ngcInfo.messierNum} and M${messierNum} both refer to ${ngcIcNum < 0 ? 'IC' : 'NGC'}${abs(ngcIcNum)}`);
      else if (messierNum)
        ngcInfo.messierNum = messierNum;
    }
  }

  console.log('Named non-stellar objects to seek in ngc2000.dat:', namedNSOs);
}

function processNgcData(contents: string): void {
  const lines = asLines(contents);
  let dividerCount = 0;
  let ngcIcStr: string;
  let ngcIcNum: number;
  let ngcInfo: NGCMatchInfo;

  for (const line of lines) {
    if (line.startsWith('-')) {
      ++dividerCount;
      continue;
    }
    else if (!line || dividerCount < 2)
      continue;

    const parts = line.split('|');
    const vmag = toNumber(parts[7], 1000);

    ngcIcStr = parts[0];
    ngcIcNum = toNumber(ngcIcStr.substring(1)) * (ngcIcStr.startsWith('I') ? -1 : 1);
    ngcInfo = ngcs[ngcIcNum];

    if (!ngcInfo && vmag > 6.0)
      continue;

    const star = { fk5Num: 0, bscNum: 0, ngcIcNum, vmag } as StarInfo;

    if (ngcInfo) {
      star.messierNum = ngcInfo.messierNum;
      star.name = ngcInfo.name;
    }
    else {
      star.messierNum = 0;
      star.name = null;
    }

    const raAndD = parts[2];
    const ra_hours = toNumber(raAndD.substring(0, 2));
    const ra_mins = toNumber(raAndD.substring(3, 7));

    star.RA = ra_hours + ra_mins / 60.0;

    const de_sign = (raAndD.charAt(8) === '-' ? -1.0 : 1.0);
    const de_degs = toNumber(raAndD.substring(9, 11));
    const de_mins = toNumber(raAndD.substring(12, 14));

    star.DE = (de_degs + de_mins / 60.0) * de_sign;

    const constellationStr = parts[4].toLowerCase();

    star.constellation = constellationCodes.indexOf(constellationStr) + 1;

    ++totalDSO;
    fk5Index[highestStar + totalDSO] = star;
  }
}

async function writeStarCatalog(doDoublePrecision = false): Promise<void> {
  await mkdir('output', { recursive: true });

  const path = 'output/stars.dat';
  const file = new BinaryFile(path, 'w');
  let gapSize = 0;
  let compressedMag: number;

  await file.open();

  if (doDoublePrecision)
    await file.writeUInt8(0xFD);

  for (let i = 1; i <= highestStar + totalDSO; ++i) {
    const star = fk5Index[i];

    if (!star && i <= highestFK5) {
      ++gapSize;

      continue;
    }
    else if (gapSize > 0) {
      missingFK5 += gapSize;

      for (let j = 0; j < gapSize; ++j)
        await file.writeUInt8(0xFF);

      gapSize = 0;
    }

    if (i === highestFK5 + 1 || (highestBSC > 0 && i === highestBSC + 1) || i === highestStar + 1) {
      // This marker byte tells the star catalog reader to advance one category in the types of objects
      // it's reading -- first FK5 stars, then BSC stars, then Hipparcos stars, then DSOs.
      await file.writeUInt8(0xFE);

      // We can count on there being both FK5 and BSC stars, but if there aren't any supplemental
      // Hipparcos stars, we need the star catalog reader to advance one more step.
      if (i === highestStar + 1 && highestHIP === 0)
        await file.writeUInt8(0xFE);
    }

    bMag = min(star.vmag, bMag);

    if (star.vmag !== 1000.0)
      dMag = max(star.vmag, dMag);

    await file.writeUInt8(star.flamsteed);
    await file.writeUInt8(star.bayerRank);
    await file.writeUInt8(star.subIndex);
    await file.writeUInt8(star.constellation);

    if (doDoublePrecision) {
      await file.writeDouble(star.RA);
      await file.writeDouble(star.DE);
    }
    else {
      await file.writeFloat(star.RA);
      await file.writeFloat(star.DE);
    }

    await file.writeFloat(star.pmRA || 0);
    await file.writeFloat(star.pmDE || 0);
    compressedMag = floor((star.vmag + 2.0) * 10.0 + 0.5);
    compressedMag = min(max(compressedMag, 0), 255);
    await file.writeUInt8(compressedMag);

    if (i > highestStar) {
      await file.writeInt16(star.ngcIcNum);
      await file.writeUInt8(star.messierNum);
    }
    else if (highestBSC > 0 && i > highestBSC) {
      await file.writeUInt8(floor(star.hipNum / 0x10000));
      await file.writeUInt16(star.hipNum & 0xFFFF);
    }
    else if (i > highestFK5)
      await file.writeUInt16(star.bscNum);

    if (!star.name)
      await file.writeUInt8(0);
    else {
      const name = Buffer.from(star.name, 'utf8');
      await file.writeUInt8(name.length);
      await file.write(name);
    }

    ++total;
  }

  await file.close();
  console.log(`Output file size: ${((await safeStat(path)).size / 1024).toFixed(1)}K`);
}

function summary(): void {
  console.log('\n-- Total number of objects:', total);
  console.log('FK5 stars:', totalFK5, 'updated from HIP:', fk5UpdatesFromHIP, 'highest:', highestFK5, 'missing:', missingFK5);
  console.log('BSC stars:', totalBSC, 'updated from HIP:', bscUpdatesFromHIP);
  console.log('HIP stars:', totalHIP);
  console.log('DSOs     :', totalDSO);
  console.log('Brightest magnitude:', bMag);
  console.log('Dimmest magnitude  :', dMag);
}

(async (): Promise<void> => {
  try {
    const crossIndex = await getPossiblyCachedFile(CROSS_INDEX_FILE, CROSS_INDEX_URL, 'FK5/SAO/HD cross index');

    processCrossIndex(crossIndex);

    const bscCatalog = await getPossiblyCachedFile(YALE_BSC_FILE, YALE_BSC_URL, 'Yale Bright Star Catalog');
    const bscNotes = await getPossiblyCachedFile(YALE_BSC_NOTES_FILE, YALE_BSC_NOTES_URL, 'Yale Bright Star Notes');

    processYaleBrightStarCatalog(bscCatalog);
    processYaleBrightStarCatalogNotes(bscNotes);

    const hipparcosData = await getPossiblyCachedFile(HIPPARCOS_FILE, HIPPARCOS_URL, 'Hipparcos data',
      { maxCacheAge: THREE_MONTHS, params: HIPPARCOS_PARAMS, autoDecompress: false });

    processHipparcosStarCatalog(hipparcosData);

    const ngcNames = await getPossiblyCachedFile(NGC_NAMES_FILE, NGC_NAMES_URL, 'NGC 2000 Names',
      { maxCacheAge: THREE_MONTHS });

    processNgcNames(ngcNames);

    const ngcData = await getPossiblyCachedFile(NGC_DATA_FILE, NGC_DATA_URL, 'NGC 2000 Data',
      { maxCacheAge: THREE_MONTHS });

    processNgcData(ngcData);

    await writeStarCatalog();
    summary();
  }
  catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
