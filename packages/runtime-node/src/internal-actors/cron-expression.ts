// Cloudflare cron expressions: five fields in UTC with Quartz-like extensions.
// Weekdays run from 1 (Sunday) to 7 (Saturday). When both day fields are set,
// a day matches either one, as in Vixie cron.
// https://github.com/cloudflare/cloudflare-docs/blob/e65ba8b1fa64a5dc7c5c42a96c455398945cdf5e/src/content/docs/workers/configuration/cron-triggers.mdx#L147-L162

const minuteMs = 60_000;
const hourMs = 60 * minuteMs;
const dayMs = 24 * hourMs;
// Five years covers every date, including February 29.
const searchDays = 5 * 366;

const monthNames = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const weekdayNames = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

interface DayOfMonthField {
	any: boolean;
	days: Set<number>;
	last: boolean;
	lastWeekday: boolean;
	nearestWeekday: Set<number>;
}

// Weekdays use JavaScript numbering, 0 (Sunday) to 6 (Saturday).
interface DayOfWeekField {
	any: boolean;
	last: Set<number>;
	nth: { occurrence: number; weekday: number }[];
	weekdays: Set<number>;
}

export interface CloudflareCron {
	dayOfMonth: DayOfMonthField;
	dayOfWeek: DayOfWeekField;
	hours: Set<number>;
	minutes: Set<number>;
	months: Set<number>;
}

function parseValue(
	token: string,
	min: number,
	max: number,
	names: readonly string[] | undefined,
	label: string,
): number {
	const nameIndex = names?.indexOf(token.toUpperCase()) ?? -1;
	const value = nameIndex >= 0 ? nameIndex + min : /^\d+$/.test(token) ? Number(token) : Number.NaN;
	if (!Number.isInteger(value) || value < min || value > max) {
		throw new Error(`${label} value ${JSON.stringify(token)} must be ${min}-${max}`);
	}
	return value;
}

// One list entry of `*`, `n`, `a-b`, or any of them with `/step`. A range
// whose start is after its end wraps around, as in Quartz.
function addValues(
	values: Set<number>,
	part: string,
	min: number,
	max: number,
	names: readonly string[] | undefined,
	label: string,
): void {
	const [base = "", stepText, extra] = part.split("/");
	if (extra !== undefined || base === "") {
		throw new Error(`${label} entry ${JSON.stringify(part)} is not valid`);
	}
	const step = stepText === undefined ? 1 : parseValue(stepText, 1, max - min + 1, undefined, `${label} step`);
	let start: number;
	let end: number;
	if (base === "*" || base === "?") {
		start = min;
		end = max;
	} else if (base.includes("-")) {
		const [from = "", to = "", rest] = base.split("-");
		if (rest !== undefined) throw new Error(`${label} range ${JSON.stringify(base)} is not valid`);
		start = parseValue(from, min, max, names, label);
		end = parseValue(to, min, max, names, label);
	} else {
		start = parseValue(base, min, max, names, label);
		end = stepText === undefined ? start : max;
	}
	const size = max - min + 1;
	const count = start <= end ? end - start + 1 : max - start + 1 + end - min + 1;
	for (let offset = 0; offset < count; offset += step) {
		values.add(min + ((start - min + offset) % size));
	}
}

function parseSet(
	field: string,
	min: number,
	max: number,
	names: readonly string[] | undefined,
	label: string,
): Set<number> {
	const values = new Set<number>();
	for (const part of field.split(",")) addValues(values, part, min, max, names, label);
	return values;
}

function parseDayOfMonth(field: string): DayOfMonthField {
	const parsed: DayOfMonthField = {
		any: field === "*" || field === "?",
		days: new Set(),
		last: false,
		lastWeekday: false,
		nearestWeekday: new Set(),
	};
	for (const part of field.toUpperCase().split(",")) {
		const nearest = /^(\d+)W$/.exec(part);
		if (part === "L") parsed.last = true;
		else if (part === "LW") parsed.lastWeekday = true;
		else if (nearest?.[1] !== undefined) {
			parsed.nearestWeekday.add(parseValue(nearest[1], 1, 31, undefined, "Day of month"));
		} else addValues(parsed.days, part, 1, 31, undefined, "Day of month");
	}
	return parsed;
}

function parseDayOfWeek(field: string): DayOfWeekField {
	const parsed: DayOfWeekField = {
		any: field === "*" || field === "?",
		last: new Set(),
		nth: [],
		weekdays: new Set(),
	};
	const weekday = (token: string): number =>
		parseValue(token, 1, 7, weekdayNames, "Day of week") - 1;
	for (const part of field.toUpperCase().split(",")) {
		const nth = /^(\w+)#(\d+)$/.exec(part);
		const last = /^(\w+)L$/.exec(part);
		// A bare L is the last day of the week, Saturday.
		if (part === "L") parsed.weekdays.add(6);
		else if (nth?.[1] !== undefined && nth[2] !== undefined) {
			parsed.nth.push({
				occurrence: parseValue(nth[2], 1, 5, undefined, "Day of week occurrence"),
				weekday: weekday(nth[1]),
			});
		} else if (last?.[1] !== undefined) parsed.last.add(weekday(last[1]));
		else {
			const values = new Set<number>();
			addValues(values, part, 1, 7, weekdayNames, "Day of week");
			for (const value of values) parsed.weekdays.add(value - 1);
		}
	}
	return parsed;
}

// Throws an error that explains why Cloudflare's syntax rejects `expression`.
export function parseCloudflareCron(expression: string): CloudflareCron {
	const fields = expression.trim().split(/\s+/);
	const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
	if (
		fields.length !== 5 ||
		minute === undefined ||
		hour === undefined ||
		dayOfMonth === undefined ||
		month === undefined ||
		dayOfWeek === undefined
	) {
		throw new Error("expected exactly five fields");
	}
	return {
		dayOfMonth: parseDayOfMonth(dayOfMonth),
		dayOfWeek: parseDayOfWeek(dayOfWeek),
		hours: parseSet(hour, 0, 23, undefined, "Hour"),
		minutes: parseSet(minute, 0, 59, undefined, "Minute"),
		months: parseSet(month, 1, 12, monthNames, "Month"),
	};
}

function lastDayOfMonth(year: number, month: number): number {
	return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function weekdayOf(year: number, month: number, day: number): number {
	return new Date(Date.UTC(year, month, day)).getUTCDay();
}

// Quartz's `nW`: the weekday nearest to day n that stays in the month.
function nearestWeekday(year: number, month: number, day: number, lastDay: number): number | undefined {
	if (day > lastDay) return undefined;
	const weekday = weekdayOf(year, month, day);
	if (weekday === 6) return day === 1 ? 3 : day - 1;
	if (weekday === 0) return day === lastDay ? day - 2 : day + 1;
	return day;
}

function dayMatches(cron: CloudflareCron, year: number, month: number, day: number): boolean {
	const { dayOfMonth, dayOfWeek } = cron;
	const lastDay = lastDayOfMonth(year, month);
	const lastWeekday = nearestWeekday(year, month, lastDay, lastDay);
	const domMatches =
		dayOfMonth.days.has(day) ||
		(dayOfMonth.last && day === lastDay) ||
		(dayOfMonth.lastWeekday && day === lastWeekday) ||
		[...dayOfMonth.nearestWeekday].some(
			(target) => nearestWeekday(year, month, target, lastDay) === day,
		);
	const weekday = weekdayOf(year, month, day);
	const dowMatches =
		dayOfWeek.weekdays.has(weekday) ||
		dayOfWeek.nth.some(
			(entry) => entry.weekday === weekday && Math.ceil(day / 7) === entry.occurrence,
		) ||
		(dayOfWeek.last.has(weekday) && day + 7 > lastDay);
	if (dayOfMonth.any && dayOfWeek.any) return true;
	if (dayOfMonth.any) return dowMatches;
	if (dayOfWeek.any) return domMatches;
	return domMatches || dowMatches;
}

export function cloudflareCronMatches(cron: CloudflareCron, timeMs: number): boolean {
	const date = new Date(timeMs);
	return (
		cron.minutes.has(date.getUTCMinutes()) &&
		cron.hours.has(date.getUTCHours()) &&
		cron.months.has(date.getUTCMonth() + 1) &&
		dayMatches(cron, date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
	);
}

// The first matching minute after `afterMs`, or undefined when the expression
// never matches, such as February 30.
export function nextCloudflareCronTime(cron: CloudflareCron, afterMs: number): number | undefined {
	const start = Math.floor(afterMs / minuteMs) * minuteMs + minuteMs;
	const hours = [...cron.hours].sort((left, right) => left - right);
	const minutes = [...cron.minutes].sort((left, right) => left - right);
	let dayStart = start - (start % dayMs);
	for (let index = 0; index < searchDays; index += 1, dayStart += dayMs) {
		const date = new Date(dayStart);
		if (
			!cron.months.has(date.getUTCMonth() + 1) ||
			!dayMatches(cron, date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
		) {
			continue;
		}
		for (const hour of hours) {
			for (const minute of minutes) {
				const time = dayStart + hour * hourMs + minute * minuteMs;
				if (time >= start) return time;
			}
		}
	}
	return undefined;
}
