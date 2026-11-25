CREATE TABLE `agent_skill_state_parts` (
	`skill_id` text NOT NULL,
	`revision` text NOT NULL,
	`part` integer NOT NULL,
	`content` text NOT NULL,
	PRIMARY KEY(`skill_id`, `revision`, `part`),
	FOREIGN KEY (`skill_id`) REFERENCES `agent_skills`(`id`) ON UPDATE no action ON DELETE cascade
);
