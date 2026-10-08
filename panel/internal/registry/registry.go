// Package registry 读取/保存服务注册表（data/services.json）。
package registry

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

type Auth struct {
	File   string `json:"file"`   // 相对 panel/ 或 ~ 开头
	Field  string `json:"field"`  // JSON 字段名或 ENV 变量名
	Format string `json:"format"` // "json" | "env"
}

type Service struct {
	ID      string            `json:"id"`
	Name    string            `json:"name"`
	Dir     string            `json:"dir"`     // 相对 panel/ 或绝对路径
	Command string            `json:"command"` // 可执行文件（相对 Dir）
	Args    []string          `json:"args"`
	Env     map[string]string `json:"env"`
	Port    int               `json:"port"`
	Health  string            `json:"health"`
	Auth    *Auth             `json:"auth,omitempty"` // API 代理注入的鉴权来源
}

type File struct {
	Services []Service `json:"services"`
}

func Load(path string) (*File, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var f File
	if err := json.Unmarshal(b, &f); err != nil {
		return nil, fmt.Errorf("解析 %s: %w", path, err)
	}
	if len(f.Services) == 0 {
		return nil, fmt.Errorf("%s 中没有服务", path)
	}
	return &f, nil
}

func (f *File) Save(path string) error {
	b, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(b, '\n'), 0o644)
}

func (f *File) Get(id string) (*Service, bool) {
	for i := range f.Services {
		if f.Services[i].ID == id {
			return &f.Services[i], true
		}
	}
	return nil, false
}

// ResolveDir 返回服务工作目录（base = panel/ 根目录）。
func (s *Service) ResolveDir(base string) string {
	if filepath.IsAbs(s.Dir) {
		return s.Dir
	}
	return filepath.Join(base, s.Dir)
}
