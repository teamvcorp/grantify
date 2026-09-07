/**
 * Grants.gov code lists — pure data, no network, SAFE TO IMPORT IN CLIENT CODE.
 *
 * Split out of `lib/grantsgov.ts` deliberately: that module is server-only (it
 * holds the fetch layer), but the search UI needs these same lists to render its
 * filter dropdowns. Keeping them here gives both sides one source of truth
 * without pulling the API client into the browser bundle.
 *
 * Codes are authoritative — pulled from a live search2 response, which returns
 * the full option lists alongside its results. Re-probe if Grants.gov adds any.
 */

export const GRANTS_GOV_ELIGIBILITIES: Record<string, string> = {
  '00': 'State governments',
  '01': 'County governments',
  '02': 'City or township governments',
  '04': 'Special district governments',
  '05': 'Independent school districts',
  '06': 'Public and State controlled institutions of higher education',
  '07': 'Native American tribal governments (Federally recognized)',
  '08': 'Public housing authorities/Indian housing authorities',
  '11': 'Native American tribal organizations (other than Federally recognized)',
  '12': 'Nonprofits with 501(c)(3) status (other than higher education)',
  '13': 'Nonprofits without 501(c)(3) status (other than higher education)',
  '20': 'Private institutions of higher education',
  '21': 'Individuals',
  '22': 'For profit organizations other than small businesses',
  '23': 'Small businesses',
  '25': 'Others (see eligibility text)',
  '99': 'Unrestricted (open to any entity type)',
}

/**
 * Grantify's users are nonprofits, so this is the sensible default filter.
 *
 * TRADEOFF: because multi-value lists are impossible (a comma makes Grants.gov
 * return zero — see lib/grantsgov.ts), filtering to '12' also hides the ~180
 * currently-posted "99 / Unrestricted" opportunities a nonprofit could still
 * apply for. That's why the UI exposes this as a dropdown with an "Any
 * eligibility" option instead of hard-coding it.
 */
export const DEFAULT_ELIGIBILITY = '12'

export const GRANTS_GOV_CATEGORIES: Record<string, string> = {
  ACA: 'Affordable Care Act',
  AG: 'Agriculture',
  AR: 'Arts',
  BC: 'Business and Commerce',
  CD: 'Community Development',
  CP: 'Consumer Protection',
  DPR: 'Disaster Prevention and Relief',
  ED: 'Education',
  ELT: 'Employment, Labor and Training',
  EN: 'Energy',
  EIC: 'Energy Infrastructure and Critical Minerals',
  ENV: 'Environment',
  FN: 'Food and Nutrition',
  HL: 'Health',
  HO: 'Housing',
  HU: 'Humanities',
  ISS: 'Income Security and Social Services',
  IS: 'Information and Statistics',
  IIJ: 'Infrastructure Investment and Jobs Act',
  LJL: 'Law, Justice and Legal Services',
  NR: 'Natural Resources',
  OZ: 'Opportunity Zone Benefits',
  O: 'Other',
  RT: 'Recreation and Tourism',
  RD: 'Regional Development',
  ST: 'Science, Technology and R&D',
  T: 'Transportation',
}
