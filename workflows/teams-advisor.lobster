name: teams-advisor-session
description: >
  Advisor pattern — Opus provides strategic guidance at key decision
  points, Sonnet executes and coordinates. Pure Lobster workflow.
args:
  task:
    required: true
    description: The task to accomplish

steps:
  - id: orient
    pipeline: "llm.invoke --prompt 'Read relevant files and understand the problem scope. Determine whether this is single-task or multi-task work. Report findings. Task: ${task}'"

  - id: consult_approach
    pipeline: "llm.invoke --model opus --prompt 'Review the orientation findings. Provide strategic direction: (1) Assessment, (2) Recommended approach, (3) Risks, (4) What to watch.'"
    stdin: $orient.json
    approval: Advisor must respond before proceeding

  - id: plan_execution
    pipeline: "llm.invoke --prompt 'Based on the advisor guidance, create a concrete execution plan.'"
    stdin: $consult_approach.json

  - id: execute
    parallel:
      branches:
        - id: implementation
          pipeline: "llm.invoke --prompt 'Execute the plan.'"
          stdin: $plan_execution.json
        - id: verification
          pipeline: "llm.invoke --prompt 'Independently verify the implementation. Run tests, check edge cases.'"
          stdin: $plan_execution.json

  - id: consult_review
    pipeline: "llm.invoke --model opus --prompt 'Review what was implemented and the verification results. Confirm quality or flag issues.'"
    stdin: $execute.json
    approval: Advisor must confirm before declaring done

  - id: synthesize
    pipeline: "llm.invoke --prompt 'Synthesize all results and deliver to the user.'"
    stdin: $consult_review.json
