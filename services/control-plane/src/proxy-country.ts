export type CountryProxy = { country: string } | null;

const ISO_3166_ALPHA_2 = new Set((
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ ' +
  'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR ' +
  'GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP ' +
  'KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ ' +
  'NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ ' +
  'TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'
).split(' '));

/** Accept a deployment-safe country selector; callers never submit proxy URLs. */
export function readCountryProxy(body: unknown): { value: CountryProxy } | { error: string } {
  const proxy = (body as any)?.proxy;
  if (proxy === undefined || proxy === null || proxy === false) return { value: null };
  if (!proxy || typeof proxy !== 'object' || Array.isArray(proxy)
    || Object.keys(proxy).length !== 1 || typeof proxy.country !== 'string'
    || !ISO_3166_ALPHA_2.has(proxy.country.trim())) {
    return { error: 'proxy must be false or { country: "US" } using an ISO 3166-1 alpha-2 country code' };
  }
  return { value: { country: proxy.country.trim() } };
}
