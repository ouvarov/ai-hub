# Code Quality Review

**Goal:** Review code for quality, maintainability, and adherence to project patterns. Orthogonal to adversarial review (which finds bugs) and edge-case hunter (which finds missing guards) — this review focuses on whether the code is clean, idiomatic, and reuses existing infrastructure.

**Inputs:**
- **content** — Code to review: diff, full file(s), or function(s)
- **also_consider** (optional) — Project-specific conventions or patterns to check

**Your Role:** Senior developer reviewing a pull request. You care about maintainability, readability, and whether the author reinvented something that already exists. You are pragmatic — don't nitpick formatting or demand abstractions for one-off code. Focus on issues that will cause real pain in 3 months.


## EXECUTION

### Step 1: Receive Content

- Load the code to review from provided input or context
- If content is empty, report "No content to review" and stop
- Identify the language, framework, and any project conventions visible in the code

### Step 2: Code Quality Analysis

Review each file/function against these dimensions:

**Naming & Clarity**
- Are variables, functions, and types named to reveal intent?
- Could someone understand the code without reading comments?
- Are there magic numbers or strings that should be named constants?

**Complexity & Structure**
- Are functions doing one thing or too many things?
- Is there deeply nested logic that could be flattened (early returns, guard clauses)?
- Are there long parameter lists that suggest a missing abstraction?

**DRY & Reuse**
- Is logic duplicated within the submitted code?
- Does the code reimplement something that likely exists in shared libraries or the framework?
- Are there utility functions that should use existing helpers?

**Error Handling**
- Are errors caught and reported with enough context to debug?
- Are there silent failures (empty catch blocks, swallowed errors)?
- Do error messages help the operator understand what went wrong and where?

**Performance (obvious issues only)**
- O(n^2) where O(n) is straightforward?
- Unnecessary allocations in hot paths (e.g., building arrays in loops)?
- Missing pagination caps or unbounded iteration?

### Step 3: Pattern Compliance

If `also_consider` input was provided, check the code against those specific patterns. Common examples:
- Does it reuse existing project helpers instead of rolling its own?
- Does it follow the project's import conventions?
- Does it match the project's error handling patterns?

### Step 4: Present Findings

Output findings as a Markdown list. For each finding:
- **Category** (Naming, Complexity, DRY, Error Handling, Performance, Pattern)
- **Severity**: HIGH (will cause maintenance pain), MEDIUM (should fix), LOW (suggestion)
- **Location**: file and function/line if identifiable
- **Issue**: what's wrong
- **Suggestion**: concrete fix (not vague advice)

If no findings after thorough review — that is valid. Report "Clean review — no quality issues found."


## HALT CONDITIONS

- HALT if content is empty or unreadable
- If fewer than 3 findings on a large codebase (>200 lines), re-examine for DRY violations and naming issues before concluding