/**
 * Where the admin login page sends the operator after sign-in.
 *
 * The middleware appends `?next=<the page that bounced here>` to the login
 * URL; safePostLoginRedirect honours it only when it is a same-site
 * relative path. Anything else falls back to the dashboard — an open
 * redirect here would let a crafted login link bounce the operator to an
 * attacker page carrying the fresh session cookie's origin trust.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { safePostLoginRedirect } from '../src/scripts/admin';

test('admin login redirect: no next, or a plain dashboard path', () => {
	assert.equal(safePostLoginRedirect(''), '/admin');
	assert.equal(safePostLoginRedirect('?foo=bar'), '/admin');
	assert.equal(safePostLoginRedirect('?next=/admin/'), '/admin/');
	assert.equal(safePostLoginRedirect('?next=/'), '/');
});

test('admin login redirect: returns to the gated page that bounced here', () => {
	assert.equal(safePostLoginRedirect('?next=/projects/stella/'), '/projects/stella/');
	assert.equal(safePostLoginRedirect('?next=/projects/stella/?a=b'), '/projects/stella/?a=b');
	assert.equal(safePostLoginRedirect('?next=/me/blog/'), '/me/blog/');
});

test('admin login redirect: absolute and protocol-relative URLs are refused', () => {
	assert.equal(safePostLoginRedirect('?next=https://evil.example/'), '/admin');
	assert.equal(safePostLoginRedirect('?next=http://evil.example/'), '/admin');
	assert.equal(safePostLoginRedirect('?next=//evil.example/x'), '/admin');
	assert.equal(safePostLoginRedirect('?next=javascript:alert(1)'), '/admin');
});

test('admin login redirect: backslash escapes and the login page itself are refused', () => {
	assert.equal(safePostLoginRedirect('?next=/\\evil.example/'), '/admin');
	assert.equal(safePostLoginRedirect('?next=/admin/login'), '/admin');
	assert.equal(safePostLoginRedirect('?next=/admin/login/'), '/admin');
	assert.equal(safePostLoginRedirect('?next=/admin/login?next=/projects/stella/'), '/admin');
});
