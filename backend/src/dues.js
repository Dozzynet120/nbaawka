export const duesTypes = ['branch_dues', 'bar_centre_levy', 'practising_fee'];

const feeSchedule = {
  practising_fee: { '1-4': 5000, '5-9': 10000, '10-14': 17500, '15+': 25000 },
  bar_centre_levy: { '1-4': 1250, '5-9': 2500, '10-14': 4375, '15+': 6250 },
  branch_dues: { '1-7': 5000, '8-13': 10000, '14-25': 15000, '25+': 20000 },
};

export function dueAmount(type, yearOfCall, calendarYear = new Date().getFullYear()) {
  const callYear = Number(yearOfCall);
  if (!duesTypes.includes(type) || !Number.isInteger(callYear) || callYear < 1900 || callYear > calendarYear) return null;
  const years = calendarYear - callYear;
  const category = type === 'branch_dues'
    ? years <= 7 ? '1-7' : years <= 13 ? '8-13' : years <= 25 ? '14-25' : '25+'
    : years <= 4 ? '1-4' : years <= 9 ? '5-9' : years <= 14 ? '10-14' : '15+';
  return feeSchedule[type][category];
}
