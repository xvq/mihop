package process

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"
)

type Manager struct {
	mu         sync.Mutex
	cmd        *exec.Cmd
	done       chan struct{} // closed when the child exits
	mihomoPath string
	configPath string
	startedAt  time.Time
}

func NewManager(mihomoPath string) *Manager {
	return &Manager{mihomoPath: mihomoPath}
}

func (m *Manager) SetMihomoPath(path string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.mihomoPath = path
}

// Start 启动 mihomo。configPath 非空时更新配置路径。
func (m *Manager) Start(configPath string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.cmd != nil {
		return fmt.Errorf("mihomo is already running")
	}
	if configPath != "" {
		m.configPath = configPath
	}
	if m.configPath == "" {
		return fmt.Errorf("config path not set")
	}

	cmd := exec.Command(m.mihomoPath, "-f", m.configPath)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	// 将配置文件所在目录注入 SAFE_PATHS，让 mihomo 允许从该路径加载配置
	cmd.Env = append(os.Environ(), "SAFE_PATHS="+filepath.Dir(m.configPath))

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("failed to start mihomo: %w", err)
	}

	done := make(chan struct{})
	m.cmd = cmd
	m.done = done
	m.startedAt = time.Now()

	go func() {
		_ = cmd.Wait()
		close(done)
		m.mu.Lock()
		if m.cmd == cmd {
			m.cmd = nil
			m.done = nil
		}
		m.mu.Unlock()
	}()

	return nil
}

// stop 内部停止，调用方必须持有 m.mu
func (m *Manager) stop() (chan struct{}, error) {
	if m.cmd == nil {
		return nil, nil
	}
	done := m.done
	if err := m.cmd.Process.Kill(); err != nil {
		return nil, fmt.Errorf("failed to kill mihomo: %w", err)
	}
	m.cmd = nil
	m.done = nil
	return done, nil
}

// Stop 停止 mihomo 并等待进程退出
func (m *Manager) Stop() error {
	m.mu.Lock()
	done, err := m.stop()
	m.mu.Unlock()

	if err != nil {
		return err
	}
	if done != nil {
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			return fmt.Errorf("mihomo did not exit within 5s")
		}
	}
	return nil
}


type Status struct {
	Running   bool      `json:"running"`
	StartedAt time.Time `json:"started_at,omitempty"`
	PID       int       `json:"pid,omitempty"`
}

func (m *Manager) Status() Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.cmd == nil {
		return Status{Running: false}
	}
	return Status{
		Running:   true,
		StartedAt: m.startedAt,
		PID:       m.cmd.Process.Pid,
	}
}

// Shutdown 优雅关闭，供主进程退出时调用
func (m *Manager) Shutdown() {
	_ = m.Stop()
}
