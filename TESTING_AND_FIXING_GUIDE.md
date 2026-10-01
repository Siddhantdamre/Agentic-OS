# Full Testing & Bug Fixing Guide

## Overview
This document provides a comprehensive prompt for finding and fixing all bugs when running the Darex dashboard application. Use this when Docker services are available and the full stack is running.

---

## Phase 1: Setup & Start Application

### Step 1: Start Docker & Full Stack
```bash
cd /Users/addy/Coding/SaaS/Agentic-Os-SaaS
./start.sh --dev
```

**Expected Output:**
- Postgres running on :5432
- Dashboard dev server running on :3000
- All services healthy
- Wait for "Darex is up (local)" message

### Step 2: Verify Services
```bash
curl -s http://localhost:3000/api/health
curl -s http://localhost:5432 # Should fail (not HTTP)
ps aux | grep -E "postgres|node|next"
```

**Expected:** Health endpoint returns JSON, no errors in logs

---

## Phase 2: Visual Testing - All UI Pages

### Step 3: Test Each Page in Left Sidebar
Open browser: `http://localhost:3000`

**Test Each Route (30 seconds per page):**

1. **Home (/)** 
   - Check: Layout loads, no JS errors, sidebar visible
   - Look for: 404 errors, missing images, broken styling
   - Action: Click all buttons, check console for errors

2. **Ask AI (/ask-ai)**
   - Check: Chat interface loads, input field works
   - Send test message: "Hello"
   - Look for: API errors, UI breaks, response rendering issues
   - Action: Try various prompts, watch WebSocket/fetch calls

3. **Conversations (/conversations)**
   - Check: List loads, can select conversation
   - Look for: Missing data, layout breaks, filter issues
   - Action: Click each filter, scroll, search

4. **Plans (/plans)**
   - Check: Plan list renders, can approve/deny
   - Look for: Button clicks not working, state not updating
   - Action: Create/execute/cancel plans

5. **Brain (/brain)**
   - Check: Knowledge base loads, search works
   - Look for: Search results, pagination issues
   - Action: Search for something, add snippets

6. **Listings (/listings)**
   - Check: List loads, details modal opens
   - Look for: Missing fields, broken links
   - Action: Click items, check details

7. **Inquiries (/inquiries)**
   - Check: Inquiries display, can mark as read/spam
   - Look for: Action buttons not working
   - Action: Test all actions

8. **Employees (/employees)**
   - Check: Employee list loads, can add/edit
   - Look for: Form validation, submission errors
   - Action: Try adding employee, edit, delete

9. **Insight (/insight)**
   - Check: Analytics/dashboards load
   - Look for: Charts rendering, data displaying
   - Action: Check all visualizations

10. **Analytics (/analytics)**
    - Check: Reports load, filters work
    - Look for: Missing data, broken exports
    - Action: Test all filters and exports

11. **Integrations (/integrations)**
    - Check: Integration list loads
    - Look for: Connection UI, auth flows
    - Action: Try connecting a service (will fail in dev)

12. **Connectors (/connectors)**
    - Check: Connector details page loads
    - Look for: Disconnect button, status display
    - Action: Try disconnect (may fail)

13. **Billing (/billing)**
    - Check: Billing info displays
    - Look for: Missing subscription info
    - Action: Check all sections

14. **Skills (/skills)**
    - Check: Skills list loads
    - Look for: Missing skills, broken UI
    - Action: Test all features

15. **Settings (/settings)**
    - Check: Settings form loads
    - Look for: Save button works, validation
    - Action: Try changing settings

---

## Phase 3: Browser Console Debugging

### Step 4: Check Browser Console for Errors

**Open DevTools (F12) → Console tab**

**For EACH page, record:**
- Any red errors (not just warnings)
- Any failed fetch/network requests
- Any undefined variables/functions
- Any rendering warnings

**Common issues to look for:**
```
TypeError: Cannot read property 'xyz' of undefined
ReferenceError: variable not defined
Uncaught Error: API call failed
Failed to load resource: the server responded with a status of 404
```

**Action:** Screenshot each error, note the page it occurred on

---

## Phase 4: API Testing

### Step 5: Test Critical API Endpoints

**Open DevTools → Network tab**

**Test each endpoint:**
```bash
# Health check
curl http://localhost:3000/api/health

# Auth endpoints
curl http://localhost:3000/api/auth/session
curl http://localhost:3000/api/auth/logout

# Get conversations
curl http://localhost:3000/api/conversations

# Get ask-ai status
curl http://localhost:3000/api/ask-ai/status

# Get employees
curl http://localhost:3000/api/employees
```

**Check for:**
- 401/403 Unauthorized (expected, need auth)
- 500 Server errors (bugs!)
- Timeout errors (performance)
- CORS errors
- Empty responses

**For each error:**
1. Note the endpoint
2. Copy the exact error message
3. Check server logs: `docker logs darex-dashboard`

---

## Phase 5: Component Testing

### Step 6: Test Interactive Components

**For each interactive component, test:**

1. **Forms**
   - Try empty submit
   - Try invalid input
   - Try valid submit
   - Check: Error messages, success messages, state updates

2. **Modals/Dialogs**
   - Open modal
   - Try cancel/close
   - Try submit
   - Check: Modal closes, action completes

3. **Dropdowns/Selects**
   - Click to open
   - Select option
   - Check: Value updates, form resets if needed

4. **Buttons**
   - Click all buttons
   - While loading (watch for stuck states)
   - Check: Disabled state, loading spinner, success/error feedback

5. **Lists/Tables**
   - Scroll
   - Click items
   - Try search/filter
   - Check: Pagination, sorting, data accuracy

6. **Input Fields**
   - Type slowly
   - Paste text
   - Clear field
   - Check: Validation messages, char limits

---

## Phase 6: Performance & Load Testing

### Step 7: Monitor Performance

**Open DevTools → Performance tab**

**For slow pages (>2 seconds to load):**
1. Record timeline
2. Check for:
   - Long JavaScript execution
   - Blocked rendering
   - Slow API calls
3. Note suspicious functions

**Check Network tab for:**
- Large file downloads (>1MB)
- Slow requests (>5s)
- Waterfall delays

---

## Phase 7: Real-World Workflow Testing

### Step 8: Complete User Journeys

**Test complete flows:**

**Flow 1: Answer a Question**
1. Go to /ask-ai
2. Type: "What did the customer say about billing?"
3. Wait for response
4. Check: Response quality, no errors, time taken
5. Try follow-up question

**Flow 2: Create a Plan**
1. Go to /ask-ai
2. Ask: "Create a sales followup plan"
3. View generated plan
4. Approve/deny each step
5. Execute plan
6. Check: All steps complete

**Flow 3: Search & Filter**
1. Go to /conversations
2. Filter by channel (Gmail, WhatsApp, etc)
3. Search for keyword
4. Click conversation
5. Check: Correct data, no loading issues

**Flow 4: Update Employee**
1. Go to /employees
2. Click employee
3. Edit field
4. Save
5. Reload page
6. Check: Changes persisted

---

## Phase 8: Bug Collection & Categorization

### Step 9: Document All Bugs Found

**For EACH bug, create record:**

```
BUG #1
------
Page: /ask-ai
Component: ChatInput
Issue: Submit button stays disabled after sending message
Steps:
  1. Type message
  2. Click send
  3. Observe button state
Expected: Button re-enables
Actual: Button stays disabled, can't send another message
Error Message: (from console)
Severity: HIGH
Fix: (leave blank for AI to fill)
```

**Severity Levels:**
- CRITICAL: App crashes, data loss, security
- HIGH: Feature doesn't work, UI breaks
- MEDIUM: Minor UI issue, slow response
- LOW: Cosmetic issue, typo

**Organize bugs by:**
1. Component/Page affected
2. Severity (highest first)
3. Similar issues together

---

## Phase 9: Automated Testing

### Step 10: Run Test Suite

```bash
cd /Users/addy/Coding/SaaS/Agentic-Os-SaaS/apps/dashboard
pnpm test
pnpm test:coverage
```

**Review output:**
- Any failing tests
- Coverage gaps
- Flaky tests

**Add tests for bugs found:**
- Write test that reproduces bug
- Verify test fails
- Fix code
- Verify test passes

---

## Phase 10: Fix All Bugs

### Step 11: For Each Bug Found

**Process:**

1. **Understand the issue**
   - Reproduce it 3 times
   - Check browser console
   - Check server logs
   - Find the code causing it

2. **Write a failing test** (if applicable)
   - Test that proves bug exists
   - Run test, confirm it fails

3. **Fix the code**
   - Make minimal change
   - Don't refactor
   - Don't add features

4. **Verify fix**
   - Run test → should pass
   - Test manually in browser
   - Check console for errors
   - Reload page, test again

5. **Run all tests**
   ```bash
   pnpm test
   ```
   - All 57 tests must pass
   - No new warnings

6. **Commit fix**
   ```bash
   git add -A
   git commit -m "fix: [BUG #N] brief description"
   ```

---

## Phase 11: Final Verification

### Step 12: Full System Test

**Run complete checklist:**

- [ ] All pages load without 404
- [ ] No red console errors on any page
- [ ] All buttons work (click = action)
- [ ] All forms submit successfully
- [ ] All API calls return data
- [ ] Search/filter features work
- [ ] Can create/edit/delete items
- [ ] Can execute complete workflows
- [ ] No broken images or styling
- [ ] No slow pages (>3s load)
- [ ] All 57 tests pass
- [ ] ESLint: 0 warnings/errors
- [ ] Build succeeds
- [ ] No security warnings

**For each failed item:**
1. Note it
2. Create bug report
3. Fix it
4. Verify fix
5. Re-run checklist

---

## Phase 12: Performance Optimization

### Step 13: Optimize if Needed

**For pages >2s load time:**
1. Identify slow queries/calls
2. Add caching where possible
3. Optimize rendering
4. Lazy load non-critical content
5. Measure improvement

---

## Phase 13: Documentation & Closeout

### Step 14: Document Findings

Create summary:
- Total bugs found: X
- Bugs fixed: X
- Tests passing: 57/57
- Performance: OK/IMPROVED
- Ready for: PRODUCTION/STAGING

**Push final changes:**
```bash
git push origin main
```

---

## Testing Checklist Template

```
Date: ____
Tester: ____
Build: ____
Status: [ ] PASSED [ ] FAILED

Pages Tested:
- [ ] Home
- [ ] Ask AI
- [ ] Conversations
- [ ] Plans
- [ ] Brain
- [ ] Listings
- [ ] Inquiries
- [ ] Employees
- [ ] Insight
- [ ] Analytics
- [ ] Integrations
- [ ] Connectors
- [ ] Billing
- [ ] Skills
- [ ] Settings

Critical Paths:
- [ ] Answer question workflow
- [ ] Create plan workflow
- [ ] Search & filter workflow
- [ ] Update data workflow

Quality Checks:
- [ ] No console errors
- [ ] No 404s
- [ ] All buttons work
- [ ] All forms submit
- [ ] APIs respond correctly
- [ ] Pages load <3s
- [ ] All 57 tests pass
- [ ] ESLint clean

Bugs Found: ____
Bugs Fixed: ____
Status: [ ] READY FOR PROD [ ] NEEDS WORK
```

---

## Emergency Bug Fixes

**If critical bug found:**

1. Stop the app
2. Identify root cause
3. Make minimal fix
4. Test fix immediately
5. Commit with label: `fix: CRITICAL - [description]`
6. Restart app
7. Re-test

---

## Done When:

✅ All pages load
✅ No console errors
✅ All workflows complete
✅ All 57 tests pass
✅ All bugs documented and fixed
✅ Ready for production deployment
