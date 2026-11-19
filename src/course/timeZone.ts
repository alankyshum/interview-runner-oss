export const learnerTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
export const learnerTimeZoneHeaders = () => ({ "X-Interview-Time-Zone": learnerTimeZone() });
