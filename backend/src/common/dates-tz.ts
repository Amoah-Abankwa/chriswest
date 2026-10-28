/** Today's date (YYYY-MM-DD) in the school's time zone. */
export const todayIn = (timeZone: string) => new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
