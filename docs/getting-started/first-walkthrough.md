---
title: Add a video and ask questions
description: Try VideoQ's core workflow and check the results using a short video.
---

# Add a video and ask questions

VideoQ transcribes videos, finds scenes related to your questions, and answers based on them. Try the full workflow with one video: upload → course → question → play the cited scene.

To understand what happens behind these actions, see [How AI builds an answer](../concepts/how-ai-works.md).

Prerequisite: Complete [Run the development environment](local-setup.md) and log in to the local app.

## 1. Add a short video

Open the video library and upload a short video with spoken explanations. A video whose content you already know makes the first check easier. The form asks for the spoken language and starts with your display language; choose automatic detection if the language differs or is mixed.

To import from YouTube, save your own SearchAPI key in settings before registering the URL. File uploads do not need SearchAPI.

## 2. Wait for processing

A video may not be ready for questions immediately after upload. The following steps run in the background.

```mermaid
flowchart LR
    A[Submit video] --> B[Obtain timestamped text]
    B --> C[Create searchable data for each scene]
    C --> D[Ready for questions]
```

Search preparation is complete when the video status is `completed` and its transcript appears on the video detail screen. If the status stops progressing, see [video processing troubleshooting](../guides/troubleshooting.md).

## 3. Add the video to a course

Create a course and add the video. A course defines the set of videos you want to ask questions about; adding a video does not move its stored file.

For example, add a setup tutorial video to a course called “Team development environment.” See the [core data model](../concepts/domain-model.md) for the relationship between videos and courses.

## 4. Ask about the content

Ask a question in the course chat about something covered in the video.

> What are the setup steps explained in this video?

Select a citation in the answer and check that it jumps to the corresponding time in the video. Verify that the answer matches the content and that the cited scene supports the explanation.

Questions such as “How many videos are in this course?” can be answered from metadata alone, so they may not include scene citations.

## What you should be able to verify

- Your video appears in the library and you can read its transcript.
- You can add the video to a course.
- You can ask about the content and jump to a cited scene.

**Read next:** [Find your way around the code](codebase.md) to trace the operations you just tried.
