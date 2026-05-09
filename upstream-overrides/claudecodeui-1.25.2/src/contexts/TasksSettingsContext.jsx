import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import { api } from '../utils/api';
import { IS_CODEX_ONLY_HARDENED } from '../constants/config';

const TasksSettingsContext = createContext({
  tasksEnabled: true,
  setTasksEnabled: () => {},
  toggleTasksEnabled: () => {},
  isTaskMasterInstalled: null,
  isTaskMasterReady: null,
  installationStatus: null,
  isCheckingInstallation: true
});

const getStoredTasksEnabled = () => {
  try {
    const saved = localStorage.getItem('tasks-enabled');
    if (saved === null) {
      return true;
    }

    const parsed = JSON.parse(saved);
    return typeof parsed === 'boolean' ? parsed : true;
  } catch (error) {
    console.warn('Ignoring invalid tasks-enabled preference:', error);
    return true;
  }
};

const setStoredTasksEnabled = (value) => {
  try {
    localStorage.setItem('tasks-enabled', JSON.stringify(value));
  } catch (error) {
    console.warn('Failed to save tasks-enabled preference:', error);
  }
};

const hasStoredTasksEnabledPreference = () => {
  try {
    return localStorage.getItem('tasks-enabled') !== null;
  } catch {
    return false;
  }
};

export const useTasksSettings = () => {
  const context = useContext(TasksSettingsContext);
  if (!context) {
    throw new Error('useTasksSettings must be used within a TasksSettingsProvider');
  }
  return context;
};

export const TasksSettingsProvider = ({ children }) => {
  const hasUserTasksPreferenceRef = useRef(hasStoredTasksEnabledPreference());
  const [tasksEnabled, setTasksEnabled] = useState(() => {
    if (IS_CODEX_ONLY_HARDENED) {
      return false;
    }
    return getStoredTasksEnabled();
  });
  
  const [isTaskMasterInstalled, setIsTaskMasterInstalled] = useState(null);
  const [isTaskMasterReady, setIsTaskMasterReady] = useState(null);
  const [installationStatus, setInstallationStatus] = useState(null);
  const [isCheckingInstallation, setIsCheckingInstallation] = useState(true);

  // Save to localStorage whenever tasksEnabled changes
  useEffect(() => {
    if (!hasUserTasksPreferenceRef.current) {
      return;
    }

    setStoredTasksEnabled(tasksEnabled);
  }, [tasksEnabled]);

  const setUserTasksEnabled = (value) => {
    hasUserTasksPreferenceRef.current = true;
    setTasksEnabled(value);
  };

  // Check TaskMaster installation status asynchronously on component mount
  useEffect(() => {
    if (IS_CODEX_ONLY_HARDENED) {
      setIsTaskMasterInstalled(false);
      setIsTaskMasterReady(false);
      setInstallationStatus(null);
      setIsCheckingInstallation(false);
      return;
    }

    const checkInstallation = async () => {
      try {
        const response = await api.get('/taskmaster/installation-status');
        if (response.ok) {
          const data = await response.json();
          setInstallationStatus(data);
          setIsTaskMasterInstalled(data.installation?.isInstalled || false);
          setIsTaskMasterReady(data.isReady || false);
          
          // If TaskMaster is not installed and user hasn't explicitly enabled tasks,
          // disable tasks automatically
          if (!data.installation?.isInstalled && !hasUserTasksPreferenceRef.current) {
            setTasksEnabled(false);
          }
        } else {
          console.error('Failed to check TaskMaster installation status');
          setIsTaskMasterInstalled(false);
          setIsTaskMasterReady(false);
        }
      } catch (error) {
        console.error('Error checking TaskMaster installation:', error);
        setIsTaskMasterInstalled(false);
        setIsTaskMasterReady(false);
      } finally {
        setIsCheckingInstallation(false);
      }
    };

    // Run check asynchronously without blocking initial render
    setTimeout(checkInstallation, 0);
  }, []);

  const toggleTasksEnabled = () => {
    setUserTasksEnabled(prev => !prev);
  };

  const contextValue = {
    tasksEnabled,
    setTasksEnabled: setUserTasksEnabled,
    toggleTasksEnabled,
    isTaskMasterInstalled,
    isTaskMasterReady,
    installationStatus,
    isCheckingInstallation
  };

  return (
    <TasksSettingsContext.Provider value={contextValue}>
      {children}
    </TasksSettingsContext.Provider>
  );
};

export default TasksSettingsContext;
