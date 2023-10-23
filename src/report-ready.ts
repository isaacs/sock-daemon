export type ReadyState = 'READY' | 'ALREADY RUNNING'
export const reportReady = (state: ReadyState) => console.log(state)
