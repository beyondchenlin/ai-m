"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Trash2, Edit2, User, Users } from "lucide-react";
import { apiFetch } from "@/lib/api-fetch";

interface IdentityAnchor {
  id: string;
  name: string;
  description: string;
  referenceArtifactIds: string[];
  weight: number;
  required: boolean;
}

interface VariableSlot {
  id: string;
  name: string;
  type: string;
  defaultValue: string;
  options: string[];
  currentValue: string;
}

interface ForbiddenFeature {
  id: string;
  description: string;
  severity: "high" | "medium" | "low";
  enabled: boolean;
}

interface MultiAngleReference {
  id: string;
  angle: string;
  artifactId: string;
  filePath: string;
  isPrimary: boolean;
}

interface VisualSubject {
  id: string;
  name: string;
  type: string;
  description: string;
  projectId: string;
  userId: string;
  characterId: string | null;
  identityAnchors: IdentityAnchor[];
  variableSlots: VariableSlot[];
  forbiddenFeatures: ForbiddenFeature[];
  multiAngleReferences: MultiAngleReference[];
  currentVersion: number;
  createdAt: string;
  updatedAt: string;
}

interface VisualSubjectPanelProps {
  projectId: string;
}

const SUBJECT_TYPES = [
  { value: "human", label: "人类" },
  { value: "animal", label: "动物" },
  { value: "cartoon", label: "卡通" },
  { value: "mascot", label: "吉祥物" },
  { value: "robot", label: "机器人" },
  { value: "fantasy", label: "幻想生物" },
];

export function VisualSubjectPanel({ projectId }: VisualSubjectPanelProps) {
  const [subjects, setSubjects] = useState<VisualSubject[]>([]);
  const [loading, setLoading] = useState(true);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [selectedSubject, setSelectedSubject] = useState<VisualSubject | null>(null);

  // 创建表单状态
  const [newSubject, setNewSubject] = useState({
    name: "",
    type: "human",
    description: "",
  });

  useEffect(() => {
    loadSubjects();
  }, [projectId]);

  async function loadSubjects() {
    try {
      setLoading(true);
      const res = await apiFetch(`/api/projects/${projectId}/visual-subjects`);
      const data = await res.json();
      setSubjects(data.subjects || []);
    } catch (error) {
      console.error("Failed to load visual subjects:", error);
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate() {
    try {
      const res = await apiFetch(`/api/projects/${projectId}/visual-subjects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...newSubject,
          identityAnchors: [],
          variableSlots: [],
          forbiddenFeatures: [],
          multiAngleReferences: [],
        }),
      });

      if (res.ok) {
        setCreateDialogOpen(false);
        setNewSubject({ name: "", type: "human", description: "" });
        await loadSubjects();
      }
    } catch (error) {
      console.error("Failed to create visual subject:", error);
    }
  }

  async function handleDelete(subjectId: string) {
    if (!confirm("确定要删除这个视觉主体吗？")) return;

    try {
      const res = await apiFetch(
        `/api/projects/${projectId}/visual-subjects/${subjectId}`,
        { method: "DELETE" }
      );

      if (res.ok) {
        await loadSubjects();
      }
    } catch (error) {
      console.error("Failed to delete visual subject:", error);
    }
  }

  function handleEdit(subject: VisualSubject) {
    setSelectedSubject(subject);
    setEditDialogOpen(true);
  }

  async function handleUpdate() {
    if (!selectedSubject) return;

    try {
      const res = await apiFetch(
        `/api/projects/${projectId}/visual-subjects/${selectedSubject.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: selectedSubject.name,
            type: selectedSubject.type,
            description: selectedSubject.description,
          }),
        }
      );

      if (res.ok) {
        setEditDialogOpen(false);
        setSelectedSubject(null);
        await loadSubjects();
      }
    } catch (error) {
      console.error("Failed to update visual subject:", error);
    }
  }

  if (loading) {
    return <div className="text-center py-8 text-muted-foreground">加载中...</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Users className="h-5 w-5" />
          <h3 className="text-lg font-semibold">视觉主体</h3>
          <Badge variant="secondary">{subjects.length}</Badge>
        </div>
        <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
          <DialogTrigger asChild>
            <Button size="sm">
              <Plus className="h-4 w-4 mr-1" />
              创建
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>创建视觉主体</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium">名称</label>
                <Input
                  value={newSubject.name}
                  onChange={(e) =>
                    setNewSubject({ ...newSubject, name: e.target.value })
                  }
                  placeholder="输入视觉主体名称"
                />
              </div>
              <div>
                <label className="text-sm font-medium">类型</label>
                <Select
                  value={newSubject.type}
                  onValueChange={(value) =>
                    setNewSubject({ ...newSubject, type: value })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SUBJECT_TYPES.map((t) => (
                      <SelectItem key={t.value} value={t.value}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-sm font-medium">描述</label>
                <Textarea
                  value={newSubject.description}
                  onChange={(e) =>
                    setNewSubject({ ...newSubject, description: e.target.value })
                  }
                  placeholder="描述这个视觉主体的特征"
                  rows={3}
                />
              </div>
              <Button onClick={handleCreate} className="w-full">
                创建
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {subjects.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            <User className="h-12 w-12 mx-auto mb-2 opacity-50" />
            <p>暂无视觉主体</p>
            <p className="text-sm">从角色卡片导入或创建新的视觉主体</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {subjects.map((subject) => (
            <Card key={subject.id}>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <CardTitle className="text-base flex items-center gap-2">
                      {subject.name}
                      <Badge variant="outline" className="text-xs">
                        {SUBJECT_TYPES.find((t) => t.value === subject.type)?.label}
                      </Badge>
                      <Badge variant="secondary" className="text-xs">
                        v{subject.currentVersion}
                      </Badge>
                    </CardTitle>
                    <p className="text-sm text-muted-foreground mt-1">
                      {subject.description}
                    </p>
                  </div>
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleEdit(subject)}
                    >
                      <Edit2 className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDelete(subject.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <span className="text-muted-foreground">身份锚点：</span>
                    <span className="font-medium">{subject.identityAnchors.length}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">可变槽位：</span>
                    <span className="font-medium">{subject.variableSlots.length}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">禁止特征：</span>
                    <span className="font-medium">
                      {subject.forbiddenFeatures.length}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">参考图：</span>
                    <span className="font-medium">
                      {subject.multiAngleReferences.length}
                    </span>
                  </div>
                </div>
                {subject.characterId && (
                  <div className="mt-2 text-xs text-muted-foreground">
                    从角色导入：{subject.characterId}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* 编辑对话框 */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑视觉主体</DialogTitle>
          </DialogHeader>
          {selectedSubject && (
            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium">名称</label>
                <Input
                  value={selectedSubject.name}
                  onChange={(e) =>
                    setSelectedSubject({ ...selectedSubject, name: e.target.value })
                  }
                />
              </div>
              <div>
                <label className="text-sm font-medium">类型</label>
                <Select
                  value={selectedSubject.type}
                  onValueChange={(value) =>
                    setSelectedSubject({ ...selectedSubject, type: value })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SUBJECT_TYPES.map((t) => (
                      <SelectItem key={t.value} value={t.value}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-sm font-medium">描述</label>
                <Textarea
                  value={selectedSubject.description}
                  onChange={(e) =>
                    setSelectedSubject({
                      ...selectedSubject,
                      description: e.target.value,
                    })
                  }
                  rows={3}
                />
              </div>
              <Button onClick={handleUpdate} className="w-full">
                保存
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
