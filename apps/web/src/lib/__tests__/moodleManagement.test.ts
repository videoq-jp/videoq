import { parseMoodleManagementSearch } from '@videoq/trpc/moodle-management';

describe('Moodle operator registration selectors', () => {
  const tuple = { issuer: 'https://moodle.example:9443/academy', clientId: 'client', deploymentId: '23' };
  const query = new URLSearchParams(tuple).toString();
  it('retains the exact Moodle issuer and public registration tuple', () => {
    expect(parseMoodleManagementSearch('?' + query)).toEqual(tuple);
  });
  it.each(['&issuer=https://evil.example', '&clientId=other', '&deploymentId=24', '&ownerUserId=owner', '&role=admin', '&returnTo=https://evil.example'])(
    'refuses ambiguous or authority-bearing parameters: %s', suffix => expect(parseMoodleManagementSearch(query + suffix)).toBeNull());
  it.each(['http://moodle.example', 'https://user:secret@moodle.example', 'https://moodle.example/?key=secret', 'https://moodle.example/#fragment', '//evil.example'])(
    'rejects unsafe issuer %s', issuer => expect(parseMoodleManagementSearch(new URLSearchParams({ ...tuple, issuer }).toString())).toBeNull());
});
