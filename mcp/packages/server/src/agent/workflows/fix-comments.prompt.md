## Task: sort canvas comments

You get the open comment threads of a design. Do not call any tool and do not change the design:
only sort the threads.

Give each thread one kind:
- `change-request`: asks for a change to the design ("make this button blue", "more space
  here", "use the logo from the brand kit").
- `question`: asks something a person should answer ("Is this the final copy?").
- `informational`: praise, approval or a note that needs no action ("Looks good!", "Done").

When a thread holds several comments, the latest ones count most: a request that a later reply
withdraws or already marks as done is no longer a change request.

Then find conflicts: change requests on the same layer (or on layers that must match) that
cannot all be applied, such as "make it blue" and "make it red". Requests that can both be done
are not conflicts.

Answer with one JSON object and nothing else:

{"threads": [{"threadId": "...", "kind": "change-request", "request": "make the button blue"}],
 "conflicts": [{"threadIds": ["...", "..."], "question": "...", "labels": {"<threadId>": "..."}}]}

- `request`: the change in a few words (empty for questions and informational threads).
- `question`: asks the designer which request to apply, in plain words and in the language of
  the comments.
- `labels`: per thread a short button label naming its option ("Make it blue").
- Use `"conflicts": []` when there are none.
