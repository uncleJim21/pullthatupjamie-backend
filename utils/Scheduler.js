const cron = require('node-cron');

/**
 * Utility class for scheduling tasks to run at specific times in Chicago timezone
 */
class Scheduler {
  constructor() {
    this.schedules = new Map();
    this.chicoTimeZone = 'America/Chicago';
  }

  /**
   * Schedule a task to run at specific times in Chicago timezone
   * 
   * @param {string} taskId - Unique identifier for the task
   * @param {Array<string>} chicagoTimes - Array of times in HH:MM format for Chicago timezone
   * @param {Function} taskFunction - Function to execute at the scheduled times
   * @param {Object} options - Additional options
   * @param {boolean} [options.runImmediately=false] - Whether to also run the task immediately
   * @returns {boolean} - Success status
   */
  scheduleTask(taskId, chicagoTimes, taskFunction, options = {}) {
    if (!taskId || !chicagoTimes || !Array.isArray(chicagoTimes) || !taskFunction) {
      console.error('Invalid parameters for scheduleTask');
      return false;
    }

    // Stop any existing task with this ID
    this.stopTask(taskId);

    try {
      // Run immediately if requested
      if (options.runImmediately) {
        console.log(`[Scheduler] Running task ${taskId} immediately`);
        taskFunction();
      }

      // Create cron expressions for each time in Chicago timezone
      const cronSchedules = chicagoTimes.map(time => {
        const [hours, minutes] = time.split(':').map(Number);
        
        if (isNaN(hours) || isNaN(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
          throw new Error(`Invalid time format for Chicago time: ${time}`);
        }

        // Cron expression: minute hour * * *
        return `${minutes} ${hours} * * *`;
      });

      // Schedule the task for each time
      const scheduledTasks = cronSchedules.map((cronExpression, index) => {
        console.log(`[Scheduler] Scheduling task ${taskId} to run at ${chicagoTimes[index]} (Chicago time) with cron: ${cronExpression}`);
        
        return cron.schedule(cronExpression, () => {
          const now = new Date().toLocaleString('en-US', { timeZone: this.chicoTimeZone });
          console.log(`[Scheduler] Executing task ${taskId} at ${now} (Chicago time)`);
          taskFunction();
        }, {
          timezone: this.chicoTimeZone
        });
      });

      // Store the scheduled tasks
      this.schedules.set(taskId, scheduledTasks);
      return true;
    } catch (error) {
      console.error(`[Scheduler] Error scheduling task ${taskId}:`, error);
      return false;
    }
  }

  /**
   * Stop a scheduled task
   * 
   * @param {string} taskId - ID of the task to stop
   * @returns {boolean} - Success status
   */
  stopTask(taskId) {
    if (this.schedules.has(taskId)) {
      const tasks = this.schedules.get(taskId);
      tasks.forEach(task => task.stop());
      this.schedules.delete(taskId);
      console.log(`[Scheduler] Stopped task ${taskId}`);
      return true;
    }
    return false;
  }

  /**
   * Stop all scheduled tasks
   */
  stopAllTasks() {
    for (const [taskId, tasks] of this.schedules.entries()) {
      tasks.forEach(task => task.stop());
      console.log(`[Scheduler] Stopped task ${taskId}`);
    }
    this.schedules.clear();
  }

  /**
   * Get list of all scheduled tasks
   * 
   * @returns {Array<string>} - Array of task IDs
   */
  getScheduledTasks() {
    return Array.from(this.schedules.keys());
  }
}

module.exports = Scheduler; 